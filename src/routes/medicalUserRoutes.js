/**
 * @module medicalUserRoutes
 * @description REST API routes for medical user (staff) management.
 *
 * Routes:
 *   GET    /api/v1/users              - List medical users with filters
 *   GET    /api/v1/users/:id          - Get user by userId
 *   POST   /api/v1/users              - Create a new medical user
 *   PUT    /api/v1/users/:id          - Update an existing medical user
 *   DELETE /api/v1/users/:id          - Deactivate (soft-delete) a medical user
 *   POST   /api/v1/users/:id/patients - Assign patients to a medical user
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const MedicalUser = require('../models/MedicalUser');
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

async function handleMedicalUserRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  try {
    // GET /api/v1/users
    if (path === '/api/v1/users' && method === 'GET') {
      return await listUsers(req, res);
    }

    // POST /api/v1/users
    if (path === '/api/v1/users' && method === 'POST') {
      return await createUser(req, res);
    }

    // Match /api/v1/users/:id/patients
    const patientsMatch = path.match(/^\/api\/v1\/users\/([^/]+)\/patients$/);
    if (patientsMatch && method === 'POST') {
      return await assignPatients(req, res, patientsMatch[1]);
    }

    // Match /api/v1/users/:id
    const idMatch = path.match(/^\/api\/v1\/users\/([^/]+)$/);
    if (idMatch) {
      const userId = idMatch[1];
      if (method === 'GET') return await getUser(req, res, userId);
      if (method === 'PUT') return await updateUser(req, res, userId);
      if (method === 'DELETE') return await deleteUser(req, res, userId);
    }

    return null; // not handled
  } catch (err) {
    logger.error('Medical user route error', { error: err.message, path, method });
    sendJSON(res, 500, { error: 'Internal server error', message: err.message });
  }
}

// ─── List Users ──────────────────────────────────────────────────────────────

async function listUsers(req, res) {
  const query = parseQuery(req.url);
  const { page, limit, skip } = parsePagination(query);

  const filter = {};
  if (query.role) filter.role = query.role;
  if (query.active !== undefined) filter.active = query.active === 'true';
  if (query.department) filter.department = { $regex: query.department, $options: 'i' };
  if (query.institution) filter.institution = { $regex: query.institution, $options: 'i' };
  if (query.search) {
    filter.$or = [
      { firstName: { $regex: query.search, $options: 'i' } },
      { lastName: { $regex: query.search, $options: 'i' } },
      { email: { $regex: query.search, $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    MedicalUser.find(filter).skip(skip).limit(limit).sort({ lastName: 1, firstName: 1 }),
    MedicalUser.countDocuments(filter),
  ]);

  sendJSON(res, 200, {
    success: true,
    data: users.map(u => u.toSafeJSON()),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// ─── Get User ────────────────────────────────────────────────────────────────

async function getUser(req, res, userId) {
  const user = await MedicalUser.findOne({ userId });
  if (!user) {
    return sendJSON(res, 404, { error: 'User not found', userId });
  }
  sendJSON(res, 200, { success: true, data: user.toSafeJSON() });
}

// ─── Create User ─────────────────────────────────────────────────────────────

async function createUser(req, res) {
  const body = await parseBody(req);

  // Validate required fields
  const required = ['email', 'password', 'firstName', 'lastName', 'role'];
  const missing = required.filter(f => !body[f]);
  if (missing.length > 0) {
    return sendJSON(res, 400, { error: 'Missing required fields', fields: missing });
  }

  // Validate role
  const validRoles = ['doctor', 'nurse', 'admin', 'technician'];
  if (!validRoles.includes(body.role)) {
    return sendJSON(res, 400, { error: 'Invalid role', validRoles });
  }

  // Check duplicate email
  const existing = await MedicalUser.findOne({ email: body.email.toLowerCase() });
  if (existing) {
    return sendJSON(res, 409, { error: 'Email already registered' });
  }

  const user = new MedicalUser({
    userId: uuidv4(),
    email: body.email,
    passwordHash: MedicalUser.hashPassword(body.password),
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    role: body.role,
    specialty: body.specialty,
    licenseNumber: body.licenseNumber,
    department: body.department,
    institution: body.institution,
    permissions: body.permissions || [],
  });

  await user.save();
  logger.info('Medical user created', { userId: user.userId, role: user.role, email: user.email });
  sendJSON(res, 201, { success: true, data: user.toSafeJSON() });
}

// ─── Update User ─────────────────────────────────────────────────────────────

async function updateUser(req, res, userId) {
  const body = await parseBody(req);
  const user = await MedicalUser.findOne({ userId });
  if (!user) {
    return sendJSON(res, 404, { error: 'User not found', userId });
  }

  // Updatable fields
  const updatable = [
    'firstName', 'lastName', 'phone', 'role', 'specialty',
    'licenseNumber', 'department', 'institution', 'permissions', 'active',
  ];
  for (const field of updatable) {
    if (body[field] !== undefined) {
      user[field] = body[field];
    }
  }

  // Handle password update
  if (body.password) {
    user.passwordHash = MedicalUser.hashPassword(body.password);
  }

  // Handle email update (check uniqueness)
  if (body.email && body.email.toLowerCase() !== user.email) {
    const existing = await MedicalUser.findOne({ email: body.email.toLowerCase() });
    if (existing) {
      return sendJSON(res, 409, { error: 'Email already registered' });
    }
    user.email = body.email;
  }

  await user.save();
  logger.info('Medical user updated', { userId });
  sendJSON(res, 200, { success: true, data: user.toSafeJSON() });
}

// ─── Delete (Soft) User ──────────────────────────────────────────────────────

async function deleteUser(req, res, userId) {
  const user = await MedicalUser.findOne({ userId });
  if (!user) {
    return sendJSON(res, 404, { error: 'User not found', userId });
  }

  user.active = false;
  await user.save();
  logger.info('Medical user deactivated', { userId });
  sendJSON(res, 200, { success: true, message: 'User deactivated', userId });
}

// ─── Assign Patients ─────────────────────────────────────────────────────────

async function assignPatients(req, res, userId) {
  const body = await parseBody(req);
  const user = await MedicalUser.findOne({ userId });
  if (!user) {
    return sendJSON(res, 404, { error: 'User not found', userId });
  }

  if (!body.patientIds || !Array.isArray(body.patientIds)) {
    return sendJSON(res, 400, { error: 'patientIds array required' });
  }

  // Merge without duplicates
  const current = new Set(user.assignedPatients || []);
  for (const pid of body.patientIds) {
    current.add(pid);
  }
  user.assignedPatients = [...current];
  await user.save();

  logger.info('Patients assigned to medical user', { userId, count: body.patientIds.length });
  sendJSON(res, 200, {
    success: true,
    data: { userId, assignedPatients: user.assignedPatients },
  });
}

module.exports = handleMedicalUserRoutes;
