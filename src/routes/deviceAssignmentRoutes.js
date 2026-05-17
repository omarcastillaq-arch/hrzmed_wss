/**
 * @module deviceAssignmentRoutes
 * @description REST API routes for device-to-patient assignment management.
 *
 * Routes:
 *   GET    /api/v1/assignments              - List assignments with filters
 *   GET    /api/v1/assignments/:id          - Get assignment by assignmentId
 *   POST   /api/v1/assignments              - Create a new assignment
 *   PUT    /api/v1/assignments/:id          - Update an assignment
 *   POST   /api/v1/assignments/:id/return   - Return (close) an assignment
 *   GET    /api/v1/devices/:deviceId/assignments - Get assignments for a device
 *   GET    /api/v1/patients/:patientId/assignments - Get assignments for a patient
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const DeviceAssignment = require('../models/DeviceAssignment');
const Patient = require('../models/Patient');
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

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function parseQuery(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

// ─── Route Handler ───────────────────────────────────────────────────────────

async function handleDeviceAssignmentRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  try {
    // GET /api/v1/assignments
    if (path === '/api/v1/assignments' && method === 'GET') {
      return await listAssignments(req, res);
    }

    // POST /api/v1/assignments
    if (path === '/api/v1/assignments' && method === 'POST') {
      return await createAssignment(req, res);
    }

    // POST /api/v1/assignments/:id/return
    const returnMatch = path.match(/^\/api\/v1\/assignments\/([^/]+)\/return$/);
    if (returnMatch && method === 'POST') {
      return await returnDevice(req, res, returnMatch[1]);
    }

    // GET /api/v1/assignments/:id
    const idMatch = path.match(/^\/api\/v1\/assignments\/([^/]+)$/);
    if (idMatch) {
      if (method === 'GET') return await getAssignment(req, res, idMatch[1]);
      if (method === 'PUT') return await updateAssignment(req, res, idMatch[1]);
    }

    // GET /api/v1/devices/:deviceId/assignments
    const deviceMatch = path.match(/^\/api\/v1\/devices\/([^/]+)\/assignments$/);
    if (deviceMatch && method === 'GET') {
      return await getDeviceAssignments(req, res, deviceMatch[1]);
    }

    // GET /api/v1/patients/:patientId/assignments
    const patientMatch = path.match(/^\/api\/v1\/patients\/([^/]+)\/assignments$/);
    if (patientMatch && method === 'GET') {
      return await getPatientAssignments(req, res, patientMatch[1]);
    }

    return null; // not handled
  } catch (err) {
    logger.error('Device assignment route error', { error: err.message, path, method });
    sendJSON(res, 500, { error: 'Internal server error', message: err.message });
  }
}

// ─── List Assignments ────────────────────────────────────────────────────────

async function listAssignments(req, res) {
  const query = parseQuery(req.url);
  const { page, limit, skip } = parsePagination(query);

  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.deviceId) filter.deviceId = query.deviceId;
  if (query.patientId) filter.patientId = query.patientId;
  if (query.assignedBy) filter.assignedBy = query.assignedBy;
  if (query.deviceType) filter.deviceType = query.deviceType;

  const [assignments, total] = await Promise.all([
    DeviceAssignment.find(filter).skip(skip).limit(limit).sort({ assignedAt: -1 }),
    DeviceAssignment.countDocuments(filter),
  ]);

  sendJSON(res, 200, {
    success: true,
    data: assignments.map(a => a.toSafeJSON()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// ─── Get Assignment ──────────────────────────────────────────────────────────

async function getAssignment(req, res, assignmentId) {
  const assignment = await DeviceAssignment.findOne({ assignmentId });
  if (!assignment) {
    return sendJSON(res, 404, { error: 'Assignment not found', assignmentId });
  }
  sendJSON(res, 200, { success: true, data: assignment.toSafeJSON() });
}

// ─── Create Assignment ──────────────────────────────────────────────────────

async function createAssignment(req, res) {
  const body = await parseBody(req);

  const required = ['deviceId', 'patientId', 'assignedBy'];
  const missing = required.filter(f => !body[f]);
  if (missing.length > 0) {
    return sendJSON(res, 400, { error: 'Missing required fields', fields: missing });
  }

  // Check if device is already actively assigned
  const activeAssignment = await DeviceAssignment.findOne({
    deviceId: body.deviceId,
    status: 'active',
  });
  if (activeAssignment) {
    return sendJSON(res, 409, {
      error: 'Device already assigned',
      existingAssignment: activeAssignment.assignmentId,
    });
  }

  // Verify patient exists
  const patient = await Patient.findOne({ patientId: body.patientId });
  if (!patient) {
    return sendJSON(res, 404, { error: 'Patient not found', patientId: body.patientId });
  }

  const assignment = new DeviceAssignment({
    assignmentId: uuidv4(),
    deviceId: body.deviceId,
    deviceName: body.deviceName,
    deviceType: body.deviceType,
    patientId: body.patientId,
    assignedBy: body.assignedBy,
    expectedReturnAt: body.expectedReturnAt ? new Date(body.expectedReturnAt) : undefined,
    notes: body.notes,
    monitoringConfig: body.monitoringConfig,
  });

  await assignment.save();

  // Also update the patient's assignedDevices
  await Patient.updateOne(
    { patientId: body.patientId },
    {
      $push: {
        assignedDevices: {
          deviceId: body.deviceId,
          assignedAt: assignment.assignedAt,
        },
      },
    },
  );

  logger.info('Device assigned', {
    assignmentId: assignment.assignmentId,
    deviceId: body.deviceId,
    patientId: body.patientId,
  });

  sendJSON(res, 201, { success: true, data: assignment.toSafeJSON() });
}

// ─── Update Assignment ───────────────────────────────────────────────────────

async function updateAssignment(req, res, assignmentId) {
  const body = await parseBody(req);
  const assignment = await DeviceAssignment.findOne({ assignmentId });
  if (!assignment) {
    return sendJSON(res, 404, { error: 'Assignment not found', assignmentId });
  }

  const updatable = ['notes', 'expectedReturnAt', 'monitoringConfig', 'status', 'deviceName'];
  for (const field of updatable) {
    if (body[field] !== undefined) {
      assignment[field] = body[field];
    }
  }

  await assignment.save();
  logger.info('Assignment updated', { assignmentId });
  sendJSON(res, 200, { success: true, data: assignment.toSafeJSON() });
}

// ─── Return Device ───────────────────────────────────────────────────────────

async function returnDevice(req, res, assignmentId) {
  const body = await parseBody(req);
  const assignment = await DeviceAssignment.findOne({ assignmentId });
  if (!assignment) {
    return sendJSON(res, 404, { error: 'Assignment not found', assignmentId });
  }

  if (assignment.status !== 'active') {
    return sendJSON(res, 400, { error: 'Assignment is not active', currentStatus: assignment.status });
  }

  assignment.status = 'returned';
  assignment.returnedAt = new Date();
  if (body.notes) assignment.notes = body.notes;
  await assignment.save();

  // Update patient's device record
  await Patient.updateOne(
    { patientId: assignment.patientId, 'assignedDevices.deviceId': assignment.deviceId },
    { $set: { 'assignedDevices.$.removedAt': assignment.returnedAt } },
  );

  logger.info('Device returned', { assignmentId, deviceId: assignment.deviceId });
  sendJSON(res, 200, { success: true, data: assignment.toSafeJSON() });
}

// ─── Device Assignments ──────────────────────────────────────────────────────

async function getDeviceAssignments(req, res, deviceId) {
  const query = parseQuery(req.url);
  const { page, limit, skip } = parsePagination(query);
  const filter = { deviceId };
  if (query.status) filter.status = query.status;

  const [assignments, total] = await Promise.all([
    DeviceAssignment.find(filter).skip(skip).limit(limit).sort({ assignedAt: -1 }),
    DeviceAssignment.countDocuments(filter),
  ]);

  sendJSON(res, 200, {
    success: true,
    data: assignments.map(a => a.toSafeJSON()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// ─── Patient Assignments ─────────────────────────────────────────────────────

async function getPatientAssignments(req, res, patientId) {
  const query = parseQuery(req.url);
  const { page, limit, skip } = parsePagination(query);
  const filter = { patientId };
  if (query.status) filter.status = query.status;

  const [assignments, total] = await Promise.all([
    DeviceAssignment.find(filter).skip(skip).limit(limit).sort({ assignedAt: -1 }),
    DeviceAssignment.countDocuments(filter),
  ]);

  sendJSON(res, 200, {
    success: true,
    data: assignments.map(a => a.toSafeJSON()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

module.exports = handleDeviceAssignmentRoutes;
