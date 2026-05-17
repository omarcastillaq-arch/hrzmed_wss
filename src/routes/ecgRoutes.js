/**
 * @module ecgRoutes
 * @description REST API routes for querying ECG sessions, signals, and patients.
 *
 * All routes are prefixed with /api/v1 and return JSON.
 * Supports pagination, date range filtering, and field selection.
 *
 * Routes:
 *   GET /api/v1/sessions          - List sessions with filters
 *   GET /api/v1/sessions/:id      - Get session by sessionId
 *   GET /api/v1/sessions/:id/signals - Get signals for a session
 *   GET /api/v1/patients          - List patients
 *   GET /api/v1/patients/:id      - Get patient by patientId
 *   POST /api/v1/patients         - Create or update patient
 *   GET /api/v1/sessions/active   - Get currently recording sessions
 *   GET /api/v1/stats             - Get aggregated stats
 */

'use strict';

const ECGSession = require('../models/ECGSession');
const ECGSignal = require('../models/ECGSignal');
const Patient = require('../models/Patient');
const { decompress } = require('../services/signalCompressor');
const { getActiveSessions } = require('../services/sessionManager');
const redisCache = require('../services/redisCache');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse pagination parameters from query string.
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Parse sort parameter. Format: "field:asc" or "field:desc" or "-field"
 */
function parseSort(query) {
  if (!query.sort) return { startedAt: -1 }; // default: newest first
  const sort = {};
  const parts = query.sort.split(',');
  for (const part of parts) {
    if (part.startsWith('-')) {
      sort[part.substring(1)] = -1;
    } else if (part.includes(':')) {
      const [field, dir] = part.split(':');
      sort[field] = dir === 'asc' ? 1 : -1;
    } else {
      sort[part] = 1;
    }
  }
  return sort;
}

/**
 * Send JSON response with standard envelope.
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Parse request body as JSON.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

/**
 * Parse URL and query string.
 */
function parseURL(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  const query = Object.fromEntries(url.searchParams.entries());
  return { pathname: url.pathname, query };
}

// ─── Route Handler ───────────────────────────────────────────────────────────

/**
 * Main route dispatcher. Returns true if the request was handled, false otherwise.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>}
 */
async function handleRequest(req, res) {
  const { pathname, query } = parseURL(req.url);
  const method = req.method;

  try {
    // ── Sessions ──────────────────────────────────────────────────────────
    if (pathname === '/api/v1/sessions/active' && method === 'GET') {
      return await handleGetActiveSessions(req, res);
    }
    if (pathname === '/api/v1/sessions' && method === 'GET') {
      return await handleListSessions(req, res, query);
    }

    // Session by ID
    const sessionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
    if (sessionMatch && method === 'GET') {
      return await handleGetSession(req, res, sessionMatch[1]);
    }

    // Signals for a session
    const signalMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/signals$/);
    if (signalMatch && method === 'GET') {
      return await handleGetSessionSignals(req, res, signalMatch[1], query);
    }

    // ── Patients ──────────────────────────────────────────────────────────
    if (pathname === '/api/v1/patients' && method === 'GET') {
      return await handleListPatients(req, res, query);
    }
    if (pathname === '/api/v1/patients' && method === 'POST') {
      return await handleCreatePatient(req, res);
    }

    const patientMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)$/);
    if (patientMatch && method === 'GET') {
      return await handleGetPatient(req, res, patientMatch[1]);
    }

    // ── Stats ─────────────────────────────────────────────────────────────
    if (pathname === '/api/v1/stats' && method === 'GET') {
      return await handleGetStats(req, res);
    }

    return false; // Not handled by ECG routes
  } catch (err) {
    logger.error('API route error', { pathname, method, error: err.message });
    sendJSON(res, 500, { error: 'Internal server error', message: err.message });
    return true;
  }
}

// ─── Session Handlers ────────────────────────────────────────────────────────

async function handleListSessions(req, res, query) {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query);

  // Build cache key from query params
  const cacheKey = `sessions:${JSON.stringify({ ...query, page, limit })}`;
  const cached = await redisCache.getCachedQueryResult(cacheKey);
  if (cached) {
    sendJSON(res, 200, { ...cached, cached: true });
    return true;
  }

  // Build filter
  const filter = {};
  if (query.patientId) filter.patientId = query.patientId;
  if (query.deviceId) filter['device.deviceId'] = query.deviceId;
  if (query.status) filter.status = query.status;

  // Date range filters
  if (query.startDate || query.endDate) {
    filter.startedAt = {};
    if (query.startDate) filter.startedAt.$gte = new Date(query.startDate);
    if (query.endDate) filter.startedAt.$lte = new Date(query.endDate);
  }

  // Duration filter (in seconds)
  if (query.minDuration || query.maxDuration) {
    filter.durationMs = {};
    if (query.minDuration) filter.durationMs.$gte = parseInt(query.minDuration, 10) * 1000;
    if (query.maxDuration) filter.durationMs.$lte = parseInt(query.maxDuration, 10) * 1000;
  }

  const [sessions, total] = await Promise.all([
    ECGSession.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    ECGSession.countDocuments(filter),
  ]);

  const result = {
    data: sessions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };

  // Cache the result
  await redisCache.cacheQueryResult(cacheKey, result);

  sendJSON(res, 200, result);
  return true;
}

async function handleGetSession(req, res, sessionId) {
  // Check cache first
  const cached = await redisCache.getCachedSession(sessionId);
  if (cached) {
    sendJSON(res, 200, { data: cached, cached: true });
    return true;
  }

  const session = await ECGSession.findOne({ sessionId }).lean();
  if (!session) {
    sendJSON(res, 404, { error: 'Session not found' });
    return true;
  }

  // Cache completed sessions (longer TTL) vs active (shorter TTL)
  const ttl = session.status === 'recording' ? 10 : redisCache.TTL.SESSION;
  await redisCache.cacheSession(sessionId, session);

  sendJSON(res, 200, { data: session });
  return true;
}

async function handleGetSessionSignals(req, res, sessionId, query) {
  const { page, limit, skip } = parsePagination(query);

  // Verify session exists
  const session = await ECGSession.findOne({ sessionId }).lean();
  if (!session) {
    sendJSON(res, 404, { error: 'Session not found' });
    return true;
  }

  // Build filter
  const filter = { sessionId };
  if (query.channelId) filter.channelId = query.channelId;

  const [signals, total] = await Promise.all([
    ECGSignal.find(filter).sort({ timestamp: 1 }).skip(skip).limit(limit).lean(),
    ECGSignal.countDocuments(filter),
  ]);

  // Decompress signals if requested (default: decompress)
  const decompressData = query.decompress !== 'false';
  const result = signals.map(sig => {
    if (sig.compressed && decompressData && sig.compressedData) {
      const samples = decompress(
        Buffer.isBuffer(sig.compressedData) ? sig.compressedData : Buffer.from(sig.compressedData.buffer || sig.compressedData),
        sig.compressionMeta?.firstSample || 0
      );
      return {
        ...sig,
        samples,
        compressedData: undefined,
      };
    }
    // Remove binary buffer from response
    if (sig.compressedData) {
      return { ...sig, compressedData: `<${sig.compressedData.length || 0} bytes>` };
    }
    return sig;
  });

  sendJSON(res, 200, {
    data: result,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    session: {
      sessionId: session.sessionId,
      deviceId: session.device?.deviceId,
      startedAt: session.startedAt,
      status: session.status,
    },
  });
  return true;
}

async function handleGetActiveSessions(req, res) {
  const active = getActiveSessions();
  sendJSON(res, 200, { data: active, count: active.length });
  return true;
}

// ─── Patient Handlers ────────────────────────────────────────────────────────

async function handleListPatients(req, res, query) {
  const { page, limit, skip } = parsePagination(query);

  const filter = {};
  if (query.active !== undefined) filter.active = query.active === 'true';
  if (query.search) {
    const regex = new RegExp(query.search, 'i');
    filter.$or = [
      { firstName: regex },
      { lastName: regex },
      { patientId: regex },
      { medicalRecordNumber: regex },
    ];
  }

  const [patients, total] = await Promise.all([
    Patient.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Patient.countDocuments(filter),
  ]);

  sendJSON(res, 200, {
    data: patients,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
  return true;
}

async function handleGetPatient(req, res, patientId) {
  const patient = await Patient.findOne({ patientId }).lean();
  if (!patient) {
    sendJSON(res, 404, { error: 'Patient not found' });
    return true;
  }

  // Include session summary
  const sessionCount = await ECGSession.countDocuments({ patientId });
  const latestSession = await ECGSession.findOne({ patientId }).sort({ startedAt: -1 }).lean();

  sendJSON(res, 200, {
    data: patient,
    sessionSummary: {
      totalSessions: sessionCount,
      latestSession: latestSession ? {
        sessionId: latestSession.sessionId,
        startedAt: latestSession.startedAt,
        status: latestSession.status,
        durationMs: latestSession.durationMs,
      } : null,
    },
  });
  return true;
}

async function handleCreatePatient(req, res) {
  const body = await parseBody(req);

  if (!body.patientId) {
    sendJSON(res, 400, { error: 'patientId is required' });
    return true;
  }

  // Upsert patient
  const patient = await Patient.findOneAndUpdate(
    { patientId: body.patientId },
    {
      $set: {
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
        gender: body.gender,
        medicalRecordNumber: body.medicalRecordNumber,
        attendingPhysician: body.attendingPhysician,
        diagnosis: body.diagnosis,
        notes: body.notes,
        active: body.active !== undefined ? body.active : true,
      },
    },
    { upsert: true, new: true, lean: true }
  );

  sendJSON(res, 201, { data: patient });
  return true;
}

// ─── Stats Handler ───────────────────────────────────────────────────────────

async function handleGetStats(req, res) {
  // Check Redis cache first
  const cached = await redisCache.getCachedStats();
  if (cached) {
    sendJSON(res, 200, { data: cached, cached: true });
    return true;
  }

  const [totalSessions, totalPatients, totalSignals, activeSessions] = await Promise.all([
    ECGSession.countDocuments(),
    Patient.countDocuments(),
    ECGSignal.countDocuments(),
    ECGSession.countDocuments({ status: 'recording' }),
  ]);

  // Average session duration
  const durationAgg = await ECGSession.aggregate([
    { $match: { durationMs: { $exists: true, $gt: 0 } } },
    { $group: { _id: null, avgDuration: { $avg: '$durationMs' }, totalDuration: { $sum: '$durationMs' } } },
  ]);

  const stats = {
    totalSessions,
    activeSessions,
    totalPatients,
    totalSignalChunks: totalSignals,
    averageDurationMs: durationAgg[0]?.avgDuration || 0,
    totalRecordingTimeMs: durationAgg[0]?.totalDuration || 0,
  };

  // Cache stats result
  await redisCache.cacheStats(stats);

  sendJSON(res, 200, { data: stats });
  return true;
}

module.exports = { handleRequest };
