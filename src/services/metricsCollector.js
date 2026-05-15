/**
 * @module metricsCollector
 * @description Real-time metrics collection for the Horizon Medical WSS server.
 *
 * Tracks:
 *   - Active WebSocket connections (total, per-role)
 *   - Message throughput and latency
 *   - WebSocket message processing latency
 *   - Error counts by category
 *   - ECG signal quality metrics (packet loss, SNR estimates)
 *   - System resource usage (CPU, memory, event loop lag)
 *   - Uptime and request counters
 *
 * Metrics are kept in a circular buffer for time-series history and are
 * exposed via the /health/detailed endpoint and monitoring dashboard.
 */

'use strict';

const os = require('os');
const logger = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────────────

/** How many snapshots to keep in history (1 per SNAPSHOT_INTERVAL_MS) */
const HISTORY_SIZE = parseInt(process.env.METRICS_HISTORY_SIZE, 10) || 360; // 1h at 10s intervals

/** Interval between metric snapshots (ms) */
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.METRICS_SNAPSHOT_INTERVAL_MS, 10) || 10000;

// ─── Metrics State ───────────────────────────────────────────────────────────

const metrics = {
  // ── Connection metrics ──────────────────────────────────────────────────
  connections: {
    current: 0,
    total: 0,          // total connections since start
    rejected: 0,       // rejected connections (auth, rate-limit, banned)
    byRole: {},        // { role: count }
    peak: 0,           // peak concurrent connections
    peakAt: null,      // when peak was reached
  },

  // ── Message metrics ─────────────────────────────────────────────────────
  messages: {
    received: 0,
    processed: 0,
    errors: 0,
    rateLimited: 0,
    byType: {},        // { type: count }
    bytesReceived: 0,
  },

  // ── Latency tracking (sliding window) ───────────────────────────────────
  latency: {
    _samples: [],       // recent latency samples (ms)
    _maxSamples: 1000,
    min: 0,
    max: 0,
    avg: 0,
    p95: 0,
    p99: 0,
  },

  // ── Error tracking ──────────────────────────────────────────────────────
  errors: {
    total: 0,
    byCategory: {},    // { category: count }
    recent: [],        // last 50 errors with timestamps
    _maxRecent: 50,
  },

  // ── ECG Signal Quality ──────────────────────────────────────────────────
  ecgQuality: {
    totalPackets: 0,
    droppedPackets: 0,
    outOfOrderPackets: 0,
    duplicatePackets: 0,
    packetLossRate: 0,        // percentage
    avgSamplesPerPacket: 0,
    _sampleCounts: [],
    _maxSampleCounts: 200,
    // Per-device tracking
    devices: {},              // { deviceId: { lastSeq, gaps, snrEstimate, ... } }
  },

  // ── System metrics ──────────────────────────────────────────────────────
  system: {
    cpuUsage: 0,
    memoryUsage: 0,
    memoryTotal: 0,
    memoryFree: 0,
    heapUsed: 0,
    heapTotal: 0,
    externalMemory: 0,
    eventLoopLag: 0,
    loadAverage: [0, 0, 0],
    uptime: 0,
  },

  // ── Time-series history ─────────────────────────────────────────────────
  history: [],

  // ── Server info ─────────────────────────────────────────────────────────
  startedAt: new Date(),
};

// ─── Event Loop Lag Measurement ──────────────────────────────────────────────

let _lastEventLoopCheck = process.hrtime.bigint();
let _eventLoopLag = 0;
let _eventLoopTimer = null;

function measureEventLoopLag() {
  const expected = 100; // ms
  const now = process.hrtime.bigint();
  const elapsed = Number(now - _lastEventLoopCheck) / 1e6; // ns -> ms
  _eventLoopLag = Math.max(0, elapsed - expected);
  _lastEventLoopCheck = now;
}

// ─── CPU Usage Tracking ──────────────────────────────────────────────────────

let _lastCpuUsage = process.cpuUsage();
let _lastCpuTime = Date.now();

function getCPUPercent() {
  const now = Date.now();
  const elapsed = (now - _lastCpuTime) * 1000; // to microseconds
  if (elapsed <= 0) return 0;
  const current = process.cpuUsage(_lastCpuUsage);
  const percent = ((current.user + current.system) / elapsed) * 100;
  _lastCpuUsage = process.cpuUsage();
  _lastCpuTime = now;
  return Math.round(percent * 100) / 100;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a new WebSocket connection.
 * @param {string} role - User role (device, monitor, admin, anonymous)
 */
function recordConnection(role) {
  metrics.connections.current++;
  metrics.connections.total++;
  metrics.connections.byRole[role] = (metrics.connections.byRole[role] || 0) + 1;

  if (metrics.connections.current > metrics.connections.peak) {
    metrics.connections.peak = metrics.connections.current;
    metrics.connections.peakAt = new Date().toISOString();
  }
}

/**
 * Record a WebSocket disconnection.
 * @param {string} role - User role
 */
function recordDisconnection(role) {
  metrics.connections.current = Math.max(0, metrics.connections.current - 1);
  if (metrics.connections.byRole[role]) {
    metrics.connections.byRole[role] = Math.max(0, metrics.connections.byRole[role] - 1);
  }
}

/**
 * Record a rejected connection attempt.
 * @param {string} reason - Rejection reason (auth, rate_limit, banned)
 */
function recordRejectedConnection(reason) {
  metrics.connections.rejected++;
  recordError('connection_rejected', reason);
}

/**
 * Record an incoming message.
 * @param {string} type - Message type (ecg_data, device_status, etc.)
 * @param {number} byteSize - Raw message size in bytes
 */
function recordMessage(type, byteSize = 0) {
  metrics.messages.received++;
  metrics.messages.byType[type] = (metrics.messages.byType[type] || 0) + 1;
  metrics.messages.bytesReceived += byteSize;
}

/**
 * Record a processed message (after validation).
 */
function recordProcessedMessage() {
  metrics.messages.processed++;
}

/**
 * Record a rate-limited message.
 */
function recordRateLimitedMessage() {
  metrics.messages.rateLimited++;
}

/**
 * Record message processing latency.
 * @param {number} latencyMs - Processing time in milliseconds
 */
function recordLatency(latencyMs) {
  const samples = metrics.latency._samples;
  samples.push(latencyMs);
  if (samples.length > metrics.latency._maxSamples) {
    samples.shift();
  }
  updateLatencyStats();
}

/**
 * Record an error.
 * @param {string} category - Error category
 * @param {string} message - Error message
 */
function recordError(category, message) {
  metrics.errors.total++;
  metrics.errors.byCategory[category] = (metrics.errors.byCategory[category] || 0) + 1;

  metrics.errors.recent.push({
    timestamp: new Date().toISOString(),
    category,
    message: String(message).substring(0, 200),
  });
  if (metrics.errors.recent.length > metrics.errors._maxRecent) {
    metrics.errors.recent.shift();
  }
}

/**
 * Record an ECG packet for quality tracking.
 * @param {Object} params
 * @param {string} params.deviceId - Source device
 * @param {string} params.channelId - Channel ID
 * @param {number} params.sequenceNumber - Packet sequence number
 * @param {number} params.sampleCount - Number of samples in packet
 * @param {number[]} [params.samples] - Raw samples for SNR estimation
 */
function recordECGPacket({ deviceId, channelId, sequenceNumber, sampleCount, samples }) {
  metrics.ecgQuality.totalPackets++;

  // Track sample counts for averaging
  metrics.ecgQuality._sampleCounts.push(sampleCount);
  if (metrics.ecgQuality._sampleCounts.length > metrics.ecgQuality._maxSampleCounts) {
    metrics.ecgQuality._sampleCounts.shift();
  }
  const counts = metrics.ecgQuality._sampleCounts;
  metrics.ecgQuality.avgSamplesPerPacket = Math.round(
    counts.reduce((a, b) => a + b, 0) / counts.length
  );

  // Per-device tracking
  const deviceKey = `${deviceId}:${channelId}`;
  if (!metrics.ecgQuality.devices[deviceKey]) {
    metrics.ecgQuality.devices[deviceKey] = {
      deviceId,
      channelId,
      totalPackets: 0,
      droppedPackets: 0,
      outOfOrder: 0,
      duplicates: 0,
      lastSequence: -1,
      snrEstimateDb: null,
      lastActivityAt: null,
    };
  }
  const dev = metrics.ecgQuality.devices[deviceKey];
  dev.totalPackets++;
  dev.lastActivityAt = new Date().toISOString();

  // Sequence number gap detection
  if (sequenceNumber !== undefined && sequenceNumber !== null && dev.lastSequence >= 0) {
    const expected = dev.lastSequence + 1;
    if (sequenceNumber > expected) {
      const gap = sequenceNumber - expected;
      dev.droppedPackets += gap;
      metrics.ecgQuality.droppedPackets += gap;
    } else if (sequenceNumber < dev.lastSequence && sequenceNumber !== 0) {
      dev.outOfOrder++;
      metrics.ecgQuality.outOfOrderPackets++;
    } else if (sequenceNumber === dev.lastSequence) {
      dev.duplicates++;
      metrics.ecgQuality.duplicatePackets++;
    }
  }
  if (sequenceNumber !== undefined && sequenceNumber !== null) {
    dev.lastSequence = sequenceNumber;
  }

  // Simple SNR estimation from samples (signal variance / noise floor)
  if (samples && samples.length >= 10) {
    dev.snrEstimateDb = estimateSNR(samples);
  }

  // Update global packet loss rate
  if (metrics.ecgQuality.totalPackets > 0) {
    metrics.ecgQuality.packetLossRate = Math.round(
      (metrics.ecgQuality.droppedPackets / (metrics.ecgQuality.totalPackets + metrics.ecgQuality.droppedPackets)) * 10000
    ) / 100;
  }
}

/**
 * Estimate Signal-to-Noise Ratio from raw samples.
 * Uses a simple method: signal power (variance of low-pass filtered) vs noise power (high-freq residual).
 * @param {number[]} samples
 * @returns {number} SNR in dB
 */
function estimateSNR(samples) {
  if (samples.length < 4) return 0;

  // Simple moving average as low-pass filter (window=3)
  const filtered = [];
  for (let i = 1; i < samples.length - 1; i++) {
    filtered.push((samples[i - 1] + samples[i] + samples[i + 1]) / 3);
  }

  // Signal power = variance of filtered signal
  const mean = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  const signalPower = filtered.reduce((a, b) => a + (b - mean) ** 2, 0) / filtered.length;

  // Noise = difference between original and filtered
  const noise = [];
  for (let i = 0; i < filtered.length; i++) {
    noise.push(samples[i + 1] - filtered[i]);
  }
  const noisePower = noise.reduce((a, b) => a + b ** 2, 0) / noise.length;

  if (noisePower === 0) return 60; // Very clean signal
  const snr = 10 * Math.log10(signalPower / noisePower);
  return Math.round(snr * 100) / 100;
}

/**
 * Get current snapshot of all metrics.
 * @returns {Object} Metrics snapshot
 */
function getSnapshot() {
  updateSystemMetrics();

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    connections: { ...metrics.connections, byRole: { ...metrics.connections.byRole } },
    messages: { ...metrics.messages, byType: { ...metrics.messages.byType } },
    latency: {
      min: metrics.latency.min,
      max: metrics.latency.max,
      avg: metrics.latency.avg,
      p95: metrics.latency.p95,
      p99: metrics.latency.p99,
      sampleCount: metrics.latency._samples.length,
    },
    errors: {
      total: metrics.errors.total,
      byCategory: { ...metrics.errors.byCategory },
      recent: metrics.errors.recent.slice(-10),
    },
    ecgQuality: {
      totalPackets: metrics.ecgQuality.totalPackets,
      droppedPackets: metrics.ecgQuality.droppedPackets,
      outOfOrderPackets: metrics.ecgQuality.outOfOrderPackets,
      duplicatePackets: metrics.ecgQuality.duplicatePackets,
      packetLossRate: metrics.ecgQuality.packetLossRate,
      avgSamplesPerPacket: metrics.ecgQuality.avgSamplesPerPacket,
      devices: { ...metrics.ecgQuality.devices },
    },
    system: { ...metrics.system },
  };
}

/**
 * Get time-series history of metrics.
 * @param {number} [count] - Number of recent entries to return
 * @returns {Object[]}
 */
function getHistory(count) {
  const n = count || metrics.history.length;
  return metrics.history.slice(-n);
}

/**
 * Reset all metrics (for testing).
 */
function reset() {
  metrics.connections.current = 0;
  metrics.connections.total = 0;
  metrics.connections.rejected = 0;
  metrics.connections.byRole = {};
  metrics.connections.peak = 0;
  metrics.connections.peakAt = null;

  metrics.messages.received = 0;
  metrics.messages.processed = 0;
  metrics.messages.errors = 0;
  metrics.messages.rateLimited = 0;
  metrics.messages.byType = {};
  metrics.messages.bytesReceived = 0;

  metrics.latency._samples = [];
  metrics.latency.min = 0;
  metrics.latency.max = 0;
  metrics.latency.avg = 0;
  metrics.latency.p95 = 0;
  metrics.latency.p99 = 0;

  metrics.errors.total = 0;
  metrics.errors.byCategory = {};
  metrics.errors.recent = [];

  metrics.ecgQuality.totalPackets = 0;
  metrics.ecgQuality.droppedPackets = 0;
  metrics.ecgQuality.outOfOrderPackets = 0;
  metrics.ecgQuality.duplicatePackets = 0;
  metrics.ecgQuality.packetLossRate = 0;
  metrics.ecgQuality.avgSamplesPerPacket = 0;
  metrics.ecgQuality._sampleCounts = [];
  metrics.ecgQuality.devices = {};

  metrics.history = [];
  metrics.startedAt = new Date();
}

// ─── Internal Functions ──────────────────────────────────────────────────────

let _snapshotTimer = null;

/**
 * Start periodic metric snapshots and event loop measurement.
 */
function start() {
  _eventLoopTimer = setInterval(measureEventLoopLag, 100);
  _snapshotTimer = setInterval(takeSnapshot, SNAPSHOT_INTERVAL_MS);
  logger.info('MetricsCollector started', {
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
    historySize: HISTORY_SIZE,
  });
}

/**
 * Stop metric collection (graceful shutdown).
 */
function stop() {
  if (_eventLoopTimer) clearInterval(_eventLoopTimer);
  if (_snapshotTimer) clearInterval(_snapshotTimer);
  _eventLoopTimer = null;
  _snapshotTimer = null;
}

function updateLatencyStats() {
  const samples = metrics.latency._samples;
  if (samples.length === 0) return;

  const sorted = [...samples].sort((a, b) => a - b);
  metrics.latency.min = sorted[0];
  metrics.latency.max = sorted[sorted.length - 1];
  metrics.latency.avg = Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100;
  metrics.latency.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  metrics.latency.p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
}

function updateSystemMetrics() {
  const mem = process.memoryUsage();
  metrics.system.cpuUsage = getCPUPercent();
  metrics.system.memoryUsage = Math.round((mem.rss / os.totalmem()) * 10000) / 100;
  metrics.system.memoryTotal = os.totalmem();
  metrics.system.memoryFree = os.freemem();
  metrics.system.heapUsed = mem.heapUsed;
  metrics.system.heapTotal = mem.heapTotal;
  metrics.system.externalMemory = mem.external || 0;
  metrics.system.eventLoopLag = Math.round(_eventLoopLag * 100) / 100;
  metrics.system.loadAverage = os.loadavg().map(v => Math.round(v * 100) / 100);
  metrics.system.uptime = process.uptime();
}

function takeSnapshot() {
  updateSystemMetrics();

  const snapshot = {
    timestamp: new Date().toISOString(),
    connections: metrics.connections.current,
    messagesReceived: metrics.messages.received,
    messagesProcessed: metrics.messages.processed,
    errors: metrics.errors.total,
    latencyAvg: metrics.latency.avg,
    latencyP95: metrics.latency.p95,
    cpuUsage: metrics.system.cpuUsage,
    memoryUsage: metrics.system.memoryUsage,
    heapUsed: metrics.system.heapUsed,
    eventLoopLag: metrics.system.eventLoopLag,
    ecgPackets: metrics.ecgQuality.totalPackets,
    packetLossRate: metrics.ecgQuality.packetLossRate,
  };

  metrics.history.push(snapshot);
  if (metrics.history.length > HISTORY_SIZE) {
    metrics.history.shift();
  }
}

module.exports = {
  recordConnection,
  recordDisconnection,
  recordRejectedConnection,
  recordMessage,
  recordProcessedMessage,
  recordRateLimitedMessage,
  recordLatency,
  recordError,
  recordECGPacket,
  estimateSNR,
  getSnapshot,
  getHistory,
  reset,
  start,
  stop,
};
