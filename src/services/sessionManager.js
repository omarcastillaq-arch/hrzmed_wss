/**
 * @module sessionManager
 * @description Manages ECG recording sessions in real-time.
 *
 * Responsibilities:
 *   - Creates sessions when a device starts sending data
 *   - Buffers incoming signal chunks and persists them in batches
 *   - Auto-detects session end via inactivity timeout
 *   - Compresses signal data before storage
 *   - Updates session metadata (duration, sample counts, quality)
 *
 * Architecture:
 *   Each active session is tracked in an in-memory Map keyed by
 *   `${connectionId}:${deviceId}`. When ECG data arrives, it's buffered
 *   and flushed to MongoDB either when the buffer fills or a timer fires.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const ECGSession = require('../models/ECGSession');
const ECGSignal = require('../models/ECGSignal');
const { compress } = require('./signalCompressor');

// ─── Configuration ───────────────────────────────────────────────────────────

/** How many signal chunks to buffer before flushing to DB */
const FLUSH_BUFFER_SIZE = parseInt(process.env.ECG_FLUSH_BUFFER_SIZE, 10) || 50;

/** Inactivity timeout before auto-closing a session (ms) */
const SESSION_INACTIVITY_MS = parseInt(process.env.ECG_SESSION_INACTIVITY_MS, 10) || 60000;

/** Periodic flush interval (ms) — ensures data is saved even at low throughput */
const FLUSH_INTERVAL_MS = parseInt(process.env.ECG_FLUSH_INTERVAL_MS, 10) || 10000;

/** Enable signal compression */
const COMPRESSION_ENABLED = process.env.ECG_COMPRESSION_ENABLED !== 'false';

// ─── Active Sessions Map ─────────────────────────────────────────────────────

/**
 * @typedef {Object} ActiveSession
 * @property {string} sessionId
 * @property {string} deviceId
 * @property {string} connectionId
 * @property {string|null} patientId
 * @property {Date} startedAt
 * @property {Date} lastActivityAt
 * @property {Array} signalBuffer - pending signal chunks to flush
 * @property {number} totalSamples
 * @property {Set<string>} channelsRecorded
 * @property {NodeJS.Timeout} inactivityTimer
 * @property {NodeJS.Timeout} flushTimer
 */

/** @type {Map<string, ActiveSession>} */
const activeSessions = new Map();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an incoming ECG data packet. Automatically creates or resumes a session.
 * @param {Object} params
 * @param {string} params.connectionId - WebSocket connection ID
 * @param {string} params.deviceId - Source device identifier
 * @param {string} params.channelId - BLE channel UUID (8171-8178)
 * @param {number[]} params.samples - Raw ADC samples
 * @param {number} params.timestamp - Packet timestamp (epoch ms)
 * @param {number} [params.sequenceNumber] - Optional sequence number
 * @param {string} [params.patientId] - Optional patient association
 * @returns {Promise<{ sessionId: string, buffered: number }>}
 */
async function recordECGData({ connectionId, deviceId, channelId, samples, timestamp, sequenceNumber, patientId }) {
  const sessionKey = `${connectionId}:${deviceId}`;
  let session = activeSessions.get(sessionKey);

  // Create new session if none exists for this connection+device
  if (!session) {
    session = await createSession({ connectionId, deviceId, patientId });
    activeSessions.set(sessionKey, session);
  }

  // Update activity
  session.lastActivityAt = new Date();
  session.totalSamples += samples.length;
  session.channelsRecorded.add(channelId);
  resetInactivityTimer(sessionKey);

  // Build signal chunk
  const signalChunk = {
    sessionId: session.sessionId,
    channelId,
    channelIndex: parseInt(channelId, 16) - 0x8171,
    timestamp: new Date(timestamp),
    sequenceNumber,
    samples,
    sampleCount: samples.length,
    deviceId,
  };

  // Add to buffer
  session.signalBuffer.push(signalChunk);

  // Flush if buffer is full
  if (session.signalBuffer.length >= FLUSH_BUFFER_SIZE) {
    await flushBuffer(sessionKey);
  }

  return { sessionId: session.sessionId, buffered: session.signalBuffer.length };
}

/**
 * Explicitly close a session (e.g., on WebSocket disconnect).
 * @param {string} connectionId
 * @param {string} [deviceId] - If provided, close only that device's session
 */
async function closeSession(connectionId, deviceId) {
  const keysToClose = [];

  for (const [key, session] of activeSessions) {
    if (session.connectionId === connectionId) {
      if (!deviceId || session.deviceId === deviceId) {
        keysToClose.push(key);
      }
    }
  }

  for (const key of keysToClose) {
    await finalizeSession(key, 'completed');
  }
}

/**
 * Close all sessions for a connection (called on disconnect).
 * @param {string} connectionId
 */
async function closeAllSessions(connectionId) {
  await closeSession(connectionId);
}

/**
 * Get info about currently active sessions.
 * @returns {Object[]}
 */
function getActiveSessions() {
  const result = [];
  for (const [key, session] of activeSessions) {
    result.push({
      sessionKey: key,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      connectionId: session.connectionId,
      patientId: session.patientId,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      totalSamples: session.totalSamples,
      channelsRecorded: Array.from(session.channelsRecorded),
      pendingChunks: session.signalBuffer.length,
    });
  }
  return result;
}

/**
 * Destroy all timers (for graceful shutdown).
 */
function destroy() {
  for (const [, session] of activeSessions) {
    clearTimeout(session.inactivityTimer);
    clearInterval(session.flushTimer);
  }
  activeSessions.clear();
}

// ─── Internal Functions ──────────────────────────────────────────────────────

/**
 * Create a new ECG session in DB and in-memory tracker.
 */
async function createSession({ connectionId, deviceId, patientId }) {
  const sessionId = uuidv4();
  const startedAt = new Date();

  // Persist session document
  const sessionDoc = new ECGSession({
    sessionId,
    patientId: patientId || null,
    connectionId,
    device: { deviceId },
    startedAt,
    status: 'recording',
    quality: {
      totalSamples: 0,
      droppedPackets: 0,
      channelsRecorded: [],
    },
  });

  try {
    await sessionDoc.save();
    logger.info('ECG session created', { sessionId, deviceId, connectionId });
  } catch (err) {
    logger.error('Failed to create ECG session', { error: err.message, sessionId });
    throw err;
  }

  const sessionKey = `${connectionId}:${deviceId}`;

  const activeSession = {
    sessionId,
    deviceId,
    connectionId,
    patientId: patientId || null,
    startedAt,
    lastActivityAt: startedAt,
    signalBuffer: [],
    totalSamples: 0,
    channelsRecorded: new Set(),
    inactivityTimer: null,
    flushTimer: null,
  };

  // Start periodic flush timer
  activeSession.flushTimer = setInterval(async () => {
    if (activeSession.signalBuffer.length > 0) {
      await flushBuffer(sessionKey);
    }
  }, FLUSH_INTERVAL_MS);

  return activeSession;
}

/**
 * Flush buffered signal chunks to MongoDB.
 */
async function flushBuffer(sessionKey) {
  const session = activeSessions.get(sessionKey);
  if (!session || session.signalBuffer.length === 0) return;

  // Drain buffer
  const chunks = session.signalBuffer.splice(0);

  // Compress and prepare documents
  const docs = chunks.map(chunk => {
    if (COMPRESSION_ENABLED && chunk.samples.length > 0) {
      const { buffer, meta } = compress(chunk.samples);
      return {
        sessionId: chunk.sessionId,
        channelId: chunk.channelId,
        channelIndex: chunk.channelIndex,
        timestamp: chunk.timestamp,
        sequenceNumber: chunk.sequenceNumber,
        sampleCount: chunk.sampleCount,
        deviceId: chunk.deviceId,
        compressed: true,
        compressedData: buffer,
        compressionMeta: meta,
        // Don't store raw samples when compressed
        samples: [],
      };
    }
    return chunk;
  });

  try {
    await ECGSignal.insertMany(docs, { ordered: false });

    // Update session metadata
    await ECGSession.updateOne(
      { sessionId: session.sessionId },
      {
        $inc: { signalCount: docs.length },
        $set: {
          'quality.totalSamples': session.totalSamples,
          'quality.channelsRecorded': Array.from(session.channelsRecorded),
        },
      }
    );

    logger.debug('ECG signal buffer flushed', {
      sessionId: session.sessionId,
      chunksWritten: docs.length,
      compressed: COMPRESSION_ENABLED,
    });
  } catch (err) {
    logger.error('Failed to flush ECG signal buffer', {
      sessionId: session.sessionId,
      error: err.message,
      chunksLost: docs.length,
    });
    // Re-add failed chunks back to buffer head for retry
    session.signalBuffer.unshift(...chunks);
  }
}

/**
 * Finalize and close a session.
 */
async function finalizeSession(sessionKey, status = 'completed') {
  const session = activeSessions.get(sessionKey);
  if (!session) return;

  // Clear timers
  clearTimeout(session.inactivityTimer);
  clearInterval(session.flushTimer);

  // Final flush
  await flushBuffer(sessionKey);

  // Update session in DB
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - session.startedAt.getTime();

  try {
    await ECGSession.updateOne(
      { sessionId: session.sessionId },
      {
        $set: {
          status,
          endedAt,
          durationMs,
          'quality.totalSamples': session.totalSamples,
          'quality.channelsRecorded': Array.from(session.channelsRecorded),
        },
      }
    );

    logger.info('ECG session finalized', {
      sessionId: session.sessionId,
      status,
      durationMs,
      totalSamples: session.totalSamples,
      channels: Array.from(session.channelsRecorded),
    });
  } catch (err) {
    logger.error('Failed to finalize ECG session', {
      sessionId: session.sessionId,
      error: err.message,
    });
  }

  // Remove from active map
  activeSessions.delete(sessionKey);
}

/**
 * Reset the inactivity timer for a session.
 */
function resetInactivityTimer(sessionKey) {
  const session = activeSessions.get(sessionKey);
  if (!session) return;

  clearTimeout(session.inactivityTimer);
  session.inactivityTimer = setTimeout(async () => {
    logger.info('ECG session inactivity timeout', { sessionId: session.sessionId });
    await finalizeSession(sessionKey, 'completed');
  }, SESSION_INACTIVITY_MS);
}

module.exports = {
  recordECGData,
  closeSession,
  closeAllSessions,
  getActiveSessions,
  destroy,
  // Expose for testing
  _activeSessions: activeSessions,
  _flushBuffer: flushBuffer,
};
