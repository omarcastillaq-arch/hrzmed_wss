/**
 * @module reportRoutes
 * @description REST API routes for report generation and data export.
 *
 * Routes:
 *   POST /api/v1/reports/ecg/pdf       - Generate ECG PDF report
 *   GET  /api/v1/export/ecg/:sessionId/edf  - Export ECG in EDF format
 *   GET  /api/v1/export/ecg/:sessionId/hl7  - Export ECG in HL7 FHIR JSON
 *   GET  /api/v1/export/ecg/:sessionId/csv  - Export ECG as CSV
 */

'use strict';

const ECGSession = require('../models/ECGSession');
const ECGSignal = require('../models/ECGSignal');
const Patient = require('../models/Patient');
const MedicalUser = require('../models/MedicalUser');
const { generateReport } = require('../services/pdfReportGenerator');
const { exportToEDF, exportToHL7 } = require('../services/edfExporter');
const { decompress } = require('../services/signalCompressor');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseQuery(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

/**
 * Fetch and decompress signals for a session.
 */
async function fetchSignals(sessionId, limit = 1000) {
  const signals = await ECGSignal.find({ sessionId })
    .sort({ channelId: 1, timestamp: 1 })
    .limit(limit)
    .lean();

  // Decompress if needed
  for (const sig of signals) {
    if (sig.compressed && sig.compressedData) {
      try {
        sig.samples = decompress(sig.compressedData, sig.compressionMeta);
      } catch {
        sig.samples = sig.samples || [];
      }
    }
  }

  return signals;
}

// ─── Route Handler ───────────────────────────────────────────────────────────

async function handleReportRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  try {
    // POST /api/v1/reports/ecg/pdf
    if (path === '/api/v1/reports/ecg/pdf' && method === 'POST') {
      return await generatePDFReport(req, res);
    }

    // EDF export
    const edfMatch = path.match(/^\/api\/v1\/export\/ecg\/([^/]+)\/edf$/);
    if (edfMatch && method === 'GET') {
      return await exportEDF(req, res, edfMatch[1]);
    }

    // HL7 export
    const hl7Match = path.match(/^\/api\/v1\/export\/ecg\/([^/]+)\/hl7$/);
    if (hl7Match && method === 'GET') {
      return await exportHL7JSON(req, res, hl7Match[1]);
    }

    // CSV export
    const csvMatch = path.match(/^\/api\/v1\/export\/ecg\/([^/]+)\/csv$/);
    if (csvMatch && method === 'GET') {
      return await exportCSV(req, res, csvMatch[1]);
    }

    return null; // not handled
  } catch (err) {
    logger.error('Report route error', { error: err.message, path, method });
    sendJSON(res, 500, { error: 'Internal server error', message: err.message });
  }
}

// ─── PDF Report ──────────────────────────────────────────────────────────────

async function generatePDFReport(req, res) {
  const body = await parseBody(req);

  if (!body.sessionId) {
    return sendJSON(res, 400, { error: 'sessionId is required' });
  }

  const session = await ECGSession.findOne({ sessionId: body.sessionId }).lean();
  if (!session) {
    return sendJSON(res, 404, { error: 'Session not found', sessionId: body.sessionId });
  }

  // Fetch related data
  const [patient, signals, doctor] = await Promise.all([
    session.patientId ? Patient.findOne({ patientId: session.patientId }).lean() : null,
    fetchSignals(body.sessionId, body.signalLimit || 1000),
    body.doctorId ? MedicalUser.findOne({ userId: body.doctorId }).lean() : null,
  ]);

  const pdfBuffer = await generateReport({
    patient,
    session,
    signals,
    doctor,
    notes: body.notes,
  });

  const filename = `ecg_report_${body.sessionId}_${Date.now()}.pdf`;
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': pdfBuffer.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(pdfBuffer);
}

// ─── EDF Export ──────────────────────────────────────────────────────────────

async function exportEDF(req, res, sessionId) {
  const session = await ECGSession.findOne({ sessionId }).lean();
  if (!session) {
    return sendJSON(res, 404, { error: 'Session not found', sessionId });
  }

  const query = parseQuery(req.url);
  const sampleRate = parseInt(query.sampleRate, 10) || 250;

  const [patient, signals] = await Promise.all([
    session.patientId ? Patient.findOne({ patientId: session.patientId }).lean() : null,
    fetchSignals(sessionId, 50000),
  ]);

  const edfBuffer = exportToEDF({
    patient,
    session,
    signals,
    sampleRate,
  });

  const filename = `ecg_${sessionId}_${Date.now()}.edf`;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': edfBuffer.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(edfBuffer);
}

// ─── HL7 FHIR Export ─────────────────────────────────────────────────────────

async function exportHL7JSON(req, res, sessionId) {
  const session = await ECGSession.findOne({ sessionId }).lean();
  if (!session) {
    return sendJSON(res, 404, { error: 'Session not found', sessionId });
  }

  const [patient, signals] = await Promise.all([
    session.patientId ? Patient.findOne({ patientId: session.patientId }).lean() : null,
    fetchSignals(sessionId, 10000),
  ]);

  const hl7Data = exportToHL7({ patient, session, signals });
  sendJSON(res, 200, { success: true, data: hl7Data });
}

// ─── CSV Export ──────────────────────────────────────────────────────────────

async function exportCSV(req, res, sessionId) {
  const session = await ECGSession.findOne({ sessionId }).lean();
  if (!session) {
    return sendJSON(res, 404, { error: 'Session not found', sessionId });
  }

  const signals = await fetchSignals(sessionId, 50000);

  // Group by channel
  const channelMap = {};
  for (const sig of signals) {
    const ch = sig.channelId || 'unknown';
    if (!channelMap[ch]) channelMap[ch] = [];
    channelMap[ch].push(...(sig.samples || []));
  }

  const channelIds = Object.keys(channelMap).sort();
  const maxLen = Math.max(...channelIds.map(ch => channelMap[ch].length), 0);

  // Build CSV
  let csv = `timestamp_index,${channelIds.map(ch => `channel_${ch}`).join(',')}\n`;
  for (let i = 0; i < maxLen; i++) {
    const row = [i];
    for (const ch of channelIds) {
      row.push(channelMap[ch][i] !== undefined ? channelMap[ch][i] : '');
    }
    csv += row.join(',') + '\n';
  }

  const filename = `ecg_${sessionId}_${Date.now()}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(csv),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(csv);
}

module.exports = handleReportRoutes;
