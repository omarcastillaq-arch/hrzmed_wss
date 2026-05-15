/**
 * @file api-rest.test.js
 * @description Tests for the expanded REST API — Phase 13.
 *
 * Tests cover:
 *   - Medical User CRUD (create, read, update, delete, assign patients)
 *   - Device Assignment lifecycle (create, list, update, return)
 *   - PDF report generation
 *   - EDF export
 *   - HL7 FHIR export
 *   - CSV export
 *   - OpenAPI / Swagger documentation endpoint
 *   - Model validation (MedicalUser, DeviceAssignment)
 *   - EDF exporter unit tests
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const mongoose = require('mongoose');

// ─── Models ──────────────────────────────────────────────────────────────────
const MedicalUser = require('../src/models/MedicalUser');
const DeviceAssignment = require('../src/models/DeviceAssignment');
const Patient = require('../src/models/Patient');
const ECGSession = require('../src/models/ECGSession');
const ECGSignal = require('../src/models/ECGSignal');

// ─── Route handlers ─────────────────────────────────────────────────────────
const handleMedicalUserRoutes = require('../src/routes/medicalUserRoutes');
const handleDeviceAssignmentRoutes = require('../src/routes/deviceAssignmentRoutes');
const handleReportRoutes = require('../src/routes/reportRoutes');
const handleSwaggerRoutes = require('../src/routes/swaggerRoutes');

// ─── Services ────────────────────────────────────────────────────────────────
const { generateReport } = require('../src/services/pdfReportGenerator');
const { exportToEDF, exportToHL7 } = require('../src/services/edfExporter');

// ─── Test Helpers ────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/hrzmed_test_api';
let server;
let serverPort;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let data;
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try { data = JSON.parse(raw.toString()); } catch { data = raw; }
        } else {
          data = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

before(async () => {
  await mongoose.connect(MONGO_URI);

  // Clean test collections
  await Promise.all([
    MedicalUser.deleteMany({}),
    DeviceAssignment.deleteMany({}),
    Patient.deleteMany({}),
    ECGSession.deleteMany({}),
    ECGSignal.deleteMany({}),
  ]);

  // Create test server with all routes
  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Swagger
    if (req.url.startsWith('/api/docs')) {
      const h = handleSwaggerRoutes(req, res);
      if (h) return;
    }

    // Medical users
    if (req.url.startsWith('/api/v1/users')) {
      const h = await handleMedicalUserRoutes(req, res);
      if (h !== null) return;
    }

    // Assignments
    if (req.url.startsWith('/api/v1/assignments') || req.url.match(/\/api\/v1\/(devices|patients)\/[^/]+\/assignments/)) {
      const h = await handleDeviceAssignmentRoutes(req, res);
      if (h !== null) return;
    }

    // Reports & Export
    if (req.url.startsWith('/api/v1/reports') || req.url.startsWith('/api/v1/export')) {
      const h = await handleReportRoutes(req, res);
      if (h !== null) return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await Promise.all([
    MedicalUser.deleteMany({}),
    DeviceAssignment.deleteMany({}),
    Patient.deleteMany({}),
    ECGSession.deleteMany({}),
    ECGSignal.deleteMany({}),
  ]);
  await mongoose.disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEDICAL USER CRUD TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Medical User CRUD', () => {
  let createdUserId;

  it('should create a doctor', async () => {
    const res = await request('POST', '/api/v1/users', {
      email: 'dr.smith@hospital.com',
      password: 'SecurePass123!',
      firstName: 'John',
      lastName: 'Smith',
      role: 'doctor',
      specialty: 'Cardiology',
      licenseNumber: 'MD-12345',
      department: 'Cardiology',
      institution: 'General Hospital',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.success, true);
    assert.equal(res.data.data.email, 'dr.smith@hospital.com');
    assert.equal(res.data.data.role, 'doctor');
    assert.ok(res.data.data.userId);
    assert.ok(!res.data.data.passwordHash, 'Password hash should not be exposed');
    createdUserId = res.data.data.userId;
  });

  it('should create a nurse', async () => {
    const res = await request('POST', '/api/v1/users', {
      email: 'nurse.jones@hospital.com',
      password: 'NursePass456!',
      firstName: 'Sarah',
      lastName: 'Jones',
      role: 'nurse',
      department: 'Cardiology',
      institution: 'General Hospital',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.data.role, 'nurse');
  });

  it('should create an admin', async () => {
    const res = await request('POST', '/api/v1/users', {
      email: 'admin@hospital.com',
      password: 'AdminPass789!',
      firstName: 'Alice',
      lastName: 'Admin',
      role: 'admin',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.data.role, 'admin');
  });

  it('should reject duplicate email', async () => {
    const res = await request('POST', '/api/v1/users', {
      email: 'dr.smith@hospital.com',
      password: 'AnotherPass',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'doctor',
    });
    assert.equal(res.status, 409);
  });

  it('should reject missing required fields', async () => {
    const res = await request('POST', '/api/v1/users', {
      email: 'incomplete@hospital.com',
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.fields.length > 0);
  });

  it('should reject invalid role', async () => {
    const res = await request('POST', '/api/v1/users', {
      email: 'bad@hospital.com',
      password: 'Pass123',
      firstName: 'Bad',
      lastName: 'Role',
      role: 'janitor',
    });
    assert.equal(res.status, 400);
  });

  it('should list users', async () => {
    const res = await request('GET', '/api/v1/users');
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(res.data.data.length >= 3);
    assert.ok(res.data.pagination);
    assert.ok(res.data.pagination.total >= 3);
  });

  it('should filter users by role', async () => {
    const res = await request('GET', '/api/v1/users?role=doctor');
    assert.equal(res.status, 200);
    assert.ok(res.data.data.every(u => u.role === 'doctor'));
  });

  it('should search users by name', async () => {
    const res = await request('GET', '/api/v1/users?search=Smith');
    assert.equal(res.status, 200);
    assert.ok(res.data.data.length >= 1);
  });

  it('should get user by ID', async () => {
    const res = await request('GET', `/api/v1/users/${createdUserId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.data.userId, createdUserId);
    assert.equal(res.data.data.firstName, 'John');
  });

  it('should return 404 for non-existent user', async () => {
    const res = await request('GET', '/api/v1/users/nonexistent-id');
    assert.equal(res.status, 404);
  });

  it('should update user', async () => {
    const res = await request('PUT', `/api/v1/users/${createdUserId}`, {
      specialty: 'Interventional Cardiology',
      phone: '+1-555-0123',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.data.specialty, 'Interventional Cardiology');
    assert.equal(res.data.data.phone, '+1-555-0123');
  });

  it('should deactivate (soft-delete) user', async () => {
    const res = await request('DELETE', `/api/v1/users/${createdUserId}`);
    assert.equal(res.status, 200);

    // Verify deactivated
    const check = await request('GET', `/api/v1/users/${createdUserId}`);
    assert.equal(check.data.data.active, false);
  });

  it('should assign patients to user', async () => {
    // Reactivate first
    await request('PUT', `/api/v1/users/${createdUserId}`, { active: true });

    const res = await request('POST', `/api/v1/users/${createdUserId}/patients`, {
      patientIds: ['patient-001', 'patient-002'],
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.data.assignedPatients.includes('patient-001'));
    assert.ok(res.data.data.assignedPatients.includes('patient-002'));
  });

  it('should not duplicate assigned patients', async () => {
    const res = await request('POST', `/api/v1/users/${createdUserId}/patients`, {
      patientIds: ['patient-001', 'patient-003'],
    });
    assert.equal(res.status, 200);
    const patients = res.data.data.assignedPatients;
    const unique = [...new Set(patients)];
    assert.equal(patients.length, unique.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEVICE ASSIGNMENT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Device Assignment Management', () => {
  let testPatientId = 'test-patient-da-001';
  let assignmentId;

  before(async () => {
    // Create a test patient
    await Patient.create({
      patientId: testPatientId,
      firstName: 'Test',
      lastName: 'Patient',
      gender: 'male',
    });
  });

  it('should create a device assignment', async () => {
    const res = await request('POST', '/api/v1/assignments', {
      deviceId: 'HOLTER-001',
      patientId: testPatientId,
      assignedBy: 'doctor-001',
      deviceType: 'holter',
      notes: 'Monitor for 24 hours',
      monitoringConfig: {
        duration: 24,
        channels: ['8171', '8172', '8173'],
        sampleRate: 250,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.success, true);
    assert.equal(res.data.data.deviceId, 'HOLTER-001');
    assert.equal(res.data.data.status, 'active');
    assignmentId = res.data.data.assignmentId;
  });

  it('should reject duplicate active device assignment', async () => {
    // Create another patient
    await Patient.create({
      patientId: 'test-patient-da-002',
      firstName: 'Second',
      lastName: 'Patient',
    });

    const res = await request('POST', '/api/v1/assignments', {
      deviceId: 'HOLTER-001',
      patientId: 'test-patient-da-002',
      assignedBy: 'doctor-001',
    });
    assert.equal(res.status, 409);
  });

  it('should reject assignment for nonexistent patient', async () => {
    const res = await request('POST', '/api/v1/assignments', {
      deviceId: 'HOLTER-999',
      patientId: 'nonexistent-patient',
      assignedBy: 'doctor-001',
    });
    assert.equal(res.status, 404);
  });

  it('should reject missing required fields', async () => {
    const res = await request('POST', '/api/v1/assignments', {
      deviceId: 'HOLTER-999',
    });
    assert.equal(res.status, 400);
  });

  it('should list all assignments', async () => {
    const res = await request('GET', '/api/v1/assignments');
    assert.equal(res.status, 200);
    assert.ok(res.data.data.length >= 1);
    assert.ok(res.data.pagination);
  });

  it('should filter assignments by status', async () => {
    const res = await request('GET', '/api/v1/assignments?status=active');
    assert.equal(res.status, 200);
    assert.ok(res.data.data.every(a => a.status === 'active'));
  });

  it('should get assignment by ID', async () => {
    const res = await request('GET', `/api/v1/assignments/${assignmentId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.data.assignmentId, assignmentId);
  });

  it('should update assignment', async () => {
    const res = await request('PUT', `/api/v1/assignments/${assignmentId}`, {
      notes: 'Extended to 48 hours',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.data.notes, 'Extended to 48 hours');
  });

  it('should get assignments by device', async () => {
    const res = await request('GET', '/api/v1/devices/HOLTER-001/assignments');
    assert.equal(res.status, 200);
    assert.ok(res.data.data.length >= 1);
  });

  it('should get assignments by patient', async () => {
    const res = await request('GET', `/api/v1/patients/${testPatientId}/assignments`);
    assert.equal(res.status, 200);
    assert.ok(res.data.data.length >= 1);
  });

  it('should return a device', async () => {
    const res = await request('POST', `/api/v1/assignments/${assignmentId}/return`, {
      notes: 'Device returned in good condition',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.data.status, 'returned');
    assert.ok(res.data.data.returnedAt);
  });

  it('should not return an already returned device', async () => {
    const res = await request('POST', `/api/v1/assignments/${assignmentId}/return`);
    assert.equal(res.status, 400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT & EXPORT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Report Generation & Data Export', () => {
  const testSessionId = 'test-session-export-001';
  const testPatientId = 'test-patient-export-001';

  before(async () => {
    // Create test patient
    await Patient.create({
      patientId: testPatientId,
      firstName: 'Export',
      lastName: 'TestPatient',
      gender: 'female',
      dateOfBirth: new Date('1985-03-15'),
      medicalRecordNumber: 'MRN-9876',
      diagnosis: 'Sinus tachycardia',
    });

    // Create test session
    await ECGSession.create({
      sessionId: testSessionId,
      patientId: testPatientId,
      device: { deviceId: 'HOLTER-EXPORT-001' },
      startedAt: new Date('2025-05-14T10:00:00Z'),
      endedAt: new Date('2025-05-14T10:30:00Z'),
      status: 'completed',
      quality: {
        totalSamples: 450000,
        avgSignalQuality: 92,
        channelsRecorded: ['8171', '8172'],
      },
    });

    // Create test signals (2 channels)
    const genSamples = (n) => Array.from({ length: n }, (_, i) =>
      Math.round(Math.sin(i * 0.1) * 1000000 + Math.random() * 50000));

    await ECGSignal.create([
      {
        sessionId: testSessionId,
        channelId: '8171',
        channelIndex: 0,
        timestamp: new Date('2025-05-14T10:00:00Z'),
        samples: genSamples(500),
        sampleCount: 500,
        deviceId: 'HOLTER-EXPORT-001',
      },
      {
        sessionId: testSessionId,
        channelId: '8172',
        channelIndex: 1,
        timestamp: new Date('2025-05-14T10:00:00Z'),
        samples: genSamples(500),
        sampleCount: 500,
        deviceId: 'HOLTER-EXPORT-001',
      },
    ]);
  });

  describe('PDF Report', () => {
    it('should generate a PDF report', async () => {
      const res = await request('POST', '/api/v1/reports/ecg/pdf', {
        sessionId: testSessionId,
        notes: 'Normal sinus rhythm observed.',
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/pdf');
      assert.ok(res.headers['content-disposition'].includes('.pdf'));
      assert.ok(Buffer.isBuffer(res.data));
      // PDF starts with %PDF
      assert.ok(res.data.toString('ascii', 0, 4) === '%PDF');
    });

    it('should return 400 without sessionId', async () => {
      const res = await request('POST', '/api/v1/reports/ecg/pdf', {});
      assert.equal(res.status, 400);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request('POST', '/api/v1/reports/ecg/pdf', {
        sessionId: 'nonexistent-session',
      });
      assert.equal(res.status, 404);
    });
  });

  describe('EDF Export', () => {
    it('should export ECG data in EDF format', async () => {
      const res = await request('GET', `/api/v1/export/ecg/${testSessionId}/edf`);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/octet-stream');
      assert.ok(res.headers['content-disposition'].includes('.edf'));
      assert.ok(Buffer.isBuffer(res.data));
      // EDF starts with version "0" padded to 8 bytes
      assert.ok(res.data.toString('ascii', 0, 1) === '0');
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request('GET', '/api/v1/export/ecg/nonexistent/edf');
      assert.equal(res.status, 404);
    });
  });

  describe('HL7 FHIR Export', () => {
    it('should export ECG data in HL7 FHIR format', async () => {
      const res = await request('GET', `/api/v1/export/ecg/${testSessionId}/hl7`);
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      const report = res.data.data;
      assert.equal(report.resourceType, 'DiagnosticReport');
      assert.equal(report.id, testSessionId);
      assert.equal(report.status, 'final');
      assert.ok(report.category);
      assert.ok(report.code);
      assert.ok(report.subject);
      assert.ok(report.result.length >= 2);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request('GET', '/api/v1/export/ecg/nonexistent/hl7');
      assert.equal(res.status, 404);
    });
  });

  describe('CSV Export', () => {
    it('should export ECG data as CSV', async () => {
      const res = await request('GET', `/api/v1/export/ecg/${testSessionId}/csv`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/csv'));
      assert.ok(res.headers['content-disposition'].includes('.csv'));
      const csv = res.data.toString();
      assert.ok(csv.includes('timestamp_index'));
      assert.ok(csv.includes('channel_8171'));
      assert.ok(csv.includes('channel_8172'));
      // Verify rows
      const lines = csv.trim().split('\n');
      assert.ok(lines.length > 100); // header + data rows
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request('GET', '/api/v1/export/ecg/nonexistent/csv');
      assert.equal(res.status, 404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SWAGGER / OPENAPI TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('OpenAPI / Swagger Documentation', () => {
  it('should serve OpenAPI JSON spec', async () => {
    const res = await request('GET', '/api/docs/openapi');
    assert.equal(res.status, 200);
    assert.equal(res.data.openapi, '3.0.3');
    assert.ok(res.data.info);
    assert.ok(res.data.paths);
    assert.ok(res.data.components);
    assert.ok(Object.keys(res.data.paths).length > 10);
  });

  it('should serve Swagger UI HTML', async () => {
    const options = {
      hostname: '127.0.0.1',
      port: serverPort,
      path: '/api/docs',
      method: 'GET',
    };
    const htmlRes = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.body.includes('swagger-ui'));
    assert.ok(htmlRes.body.includes('Horizon Medical'));
  });

  it('should include all major endpoint paths', async () => {
    const res = await request('GET', '/api/docs/openapi');
    const paths = Object.keys(res.data.paths);
    assert.ok(paths.includes('/api/v1/users'));
    assert.ok(paths.includes('/api/v1/assignments'));
    assert.ok(paths.includes('/api/v1/reports/ecg/pdf'));
    assert.ok(paths.includes('/api/v1/sessions'));
    assert.ok(paths.includes('/api/v1/patients'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS — Models
// ═══════════════════════════════════════════════════════════════════════════════

describe('MedicalUser Model', () => {
  it('should hash and verify passwords correctly', () => {
    const password = 'TestPassword123!';
    const hash = MedicalUser.hashPassword(password);
    assert.ok(hash.includes(':'));
    assert.ok(MedicalUser.verifyPassword(password, hash));
    assert.ok(!MedicalUser.verifyPassword('WrongPassword', hash));
  });

  it('should produce toSafeJSON without passwordHash', async () => {
    const user = new MedicalUser({
      userId: 'test-safe-json',
      email: 'safe@test.com',
      passwordHash: MedicalUser.hashPassword('test'),
      firstName: 'Safe',
      lastName: 'JSON',
      role: 'technician',
    });
    const safe = user.toSafeJSON();
    assert.ok(!safe.passwordHash);
    assert.ok(!safe.__v && safe.__v !== 0);
    assert.equal(safe.userId, 'test-safe-json');
  });

  it('should validate role enum', async () => {
    const user = new MedicalUser({
      userId: 'bad-role',
      email: 'badrole@test.com',
      passwordHash: 'x',
      firstName: 'Bad',
      lastName: 'Role',
      role: 'janitor',
    });
    try {
      await user.validate();
      assert.fail('Should have thrown validation error');
    } catch (err) {
      assert.ok(err.errors.role);
    }
  });

  it('should validate email format', async () => {
    const user = new MedicalUser({
      userId: 'bad-email',
      email: 'not-an-email',
      passwordHash: 'x',
      firstName: 'Bad',
      lastName: 'Email',
      role: 'doctor',
    });
    try {
      await user.validate();
      assert.fail('Should have thrown validation error');
    } catch (err) {
      assert.ok(err.errors.email);
    }
  });
});

describe('DeviceAssignment Model', () => {
  it('should produce toSafeJSON', () => {
    const assignment = new DeviceAssignment({
      assignmentId: 'da-test-001',
      deviceId: 'DEV-001',
      patientId: 'PAT-001',
      assignedBy: 'DOC-001',
    });
    const safe = assignment.toSafeJSON();
    assert.ok(!safe.__v && safe.__v !== 0);
    assert.equal(safe.assignmentId, 'da-test-001');
    assert.equal(safe.status, 'active');
  });

  it('should validate deviceType enum', async () => {
    const assignment = new DeviceAssignment({
      assignmentId: 'da-bad-type',
      deviceId: 'DEV-001',
      patientId: 'PAT-001',
      assignedBy: 'DOC-001',
      deviceType: 'invalid_type',
    });
    try {
      await assignment.validate();
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.errors.deviceType);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS — EDF Exporter
// ═══════════════════════════════════════════════════════════════════════════════

describe('EDF Exporter (unit)', () => {
  it('should create valid EDF buffer', () => {
    const signals = [
      { channelId: '8171', samples: Array.from({ length: 250 }, (_, i) => Math.sin(i * 0.05) * 500000) },
      { channelId: '8172', samples: Array.from({ length: 250 }, (_, i) => Math.cos(i * 0.05) * 500000) },
    ];

    const buf = exportToEDF({
      patient: { patientId: 'P001', firstName: 'Test', lastName: 'EDF', gender: 'male' },
      session: { sessionId: 'S001', startedAt: new Date() },
      signals,
      sampleRate: 250,
    });

    assert.ok(Buffer.isBuffer(buf));
    // Check EDF version
    assert.equal(buf.toString('ascii', 0, 8).trim(), '0');
    // Check number of signals
    const ns = parseInt(buf.toString('ascii', 252, 256).trim(), 10);
    assert.equal(ns, 2);
    // Header size = 256 + ns * 256
    const headerBytes = parseInt(buf.toString('ascii', 184, 192).trim(), 10);
    assert.equal(headerBytes, 256 + 2 * 256);
  });

  it('should throw with no signals', () => {
    assert.throws(() => {
      exportToEDF({ patient: null, session: null, signals: [] });
    }, /No signal data/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS — HL7 Exporter
// ═══════════════════════════════════════════════════════════════════════════════

describe('HL7 FHIR Exporter (unit)', () => {
  it('should produce valid FHIR-like DiagnosticReport', () => {
    const result = exportToHL7({
      patient: { patientId: 'P001', firstName: 'Test', lastName: 'HL7' },
      session: { sessionId: 'S001', status: 'completed', startedAt: new Date(), device: { deviceId: 'D001' } },
      signals: [
        { channelId: '8171', samples: [1, 2, 3, 4, 5] },
        { channelId: '8172', samples: [6, 7, 8, 9, 10] },
      ],
    });

    assert.equal(result.resourceType, 'DiagnosticReport');
    assert.equal(result.status, 'final');
    assert.equal(result.id, 'S001');
    assert.ok(result.subject.reference.includes('P001'));
    assert.equal(result.result.length, 2);
    assert.ok(result.meta.generatedAt);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS — PDF Generator
// ═══════════════════════════════════════════════════════════════════════════════

describe('PDF Report Generator (unit)', () => {
  it('should generate PDF buffer with patient data', async () => {
    const buf = await generateReport({
      patient: {
        patientId: 'P001',
        firstName: 'Test',
        lastName: 'PDF',
        gender: 'female',
        dateOfBirth: new Date('1990-01-01'),
        medicalRecordNumber: 'MRN-1234',
        diagnosis: 'Normal sinus rhythm',
      },
      session: {
        sessionId: 'S001',
        device: { deviceId: 'DEV-001' },
        startedAt: new Date(),
        endedAt: new Date(),
        status: 'completed',
        quality: { totalSamples: 1000, avgSignalQuality: 95 },
      },
      signals: [
        { channelId: '8171', samples: Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.1) * 100) },
      ],
      doctor: {
        firstName: 'John',
        lastName: 'Doc',
        specialty: 'Cardiology',
        licenseNumber: 'MD-111',
        institution: 'Test Hospital',
      },
      notes: 'Normal ECG, no arrhythmias detected.',
    });

    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 1000); // Should be a reasonably sized PDF
    assert.equal(buf.toString('ascii', 0, 4), '%PDF');
  });

  it('should generate PDF without optional fields', async () => {
    const buf = await generateReport({
      patient: null,
      session: null,
      signals: [],
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString('ascii', 0, 4), '%PDF');
  });
});
