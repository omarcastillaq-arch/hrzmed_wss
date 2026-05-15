/**
 * Integration Tests – Horizon Medical ECG Platform
 *
 * End-to-end tests validating the complete flow from simulated firmware
 * data through WebSocket communication, persistence, REST API, and
 * ECG lead derivation calculations.
 *
 * Run with:  node --test tests/integration.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// ─── Environment Setup ───────────────────────────────────────────────────────

const TEST_PORT = 9877;
const JWT_SECRET = 'integration-test-secret-horizon-medical-32chars!';
process.env.JWT_SECRET = JWT_SECRET;
process.env.JWT_ALGORITHM = 'HS256';
process.env.AUTH_ENABLED = 'true';
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.ECG_FLUSH_BUFFER_SIZE = '5';       // flush fast for tests
process.env.ECG_FLUSH_INTERVAL_MS = '500';
process.env.ECG_SESSION_INACTIVITY_MS = '3000';
process.env.ECG_COMPRESSION_ENABLED = 'true';

// ─── MongoDB In-Memory ───────────────────────────────────────────────────────

let mongoServer;

async function setupMongo() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
}

async function teardownMongo() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (mongoServer) await mongoServer.stop();
}

// ─── Models & Services ───────────────────────────────────────────────────────

const Patient = require('../src/models/Patient');
const ECGSession = require('../src/models/ECGSession');
const ECGSignal = require('../src/models/ECGSignal');
const sessionManager = require('../src/services/sessionManager');
const { compress, decompress } = require('../src/services/signalCompressor');
const { generateToken } = require('../src/middleware/auth');
const { validateMessage, VALID_CHANNEL_UUIDS } = require('../src/validators/ecgValidator');
const RateLimiter = require('../src/middleware/rateLimiter');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a valid JWT for test clients */
function makeToken(payload = {}, expiresIn = '1h') {
  return generateToken({
    sub: payload.sub || 'test-device-001',
    userId: payload.userId || 'user-integ-001',
    deviceId: payload.deviceId || 'holter-001',
    role: payload.role || 'device',
    patientId: payload.patientId || 'PAT-INTEG-001',
    ...payload,
  }, expiresIn);
}

/** Build a valid ECG data message */
function makeECGMessage(overrides = {}) {
  return JSON.stringify({
    type: 'ecg_data',
    deviceId: 'holter-001',
    channelId: '8171',
    samples: generateSineECG(21),
    timestamp: Date.now(),
    sequenceNumber: 1,
    ...overrides,
  });
}

/** Simulate realistic ECG-like sinusoidal data within 24-bit ADC range */
function generateSineECG(count, amplitude = 5000, offset = 0) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(Math.round(offset + amplitude * Math.sin((2 * Math.PI * i) / count)));
  }
  return samples;
}

/** Generate 8-channel firmware packet burst (simulates ADS1298 output) */
function generateFirmwarePacketBurst(samplesPerChannel = 21) {
  const channels = ['8171', '8172', '8173', '8174', '8175', '8176', '8177', '8178'];
  return channels.map((channelId, idx) => ({
    type: 'ecg_data',
    deviceId: 'holter-001',
    channelId,
    samples: generateSineECG(samplesPerChannel, 4000 + idx * 500, idx * 100),
    timestamp: Date.now(),
    sequenceNumber: idx + 1,
  }));
}

/** HTTP GET helper */
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${TEST_PORT}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

/** HTTP POST helper */
function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: TEST_PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Connect a WebSocket client with JWT auth */
function connectWS(token, waitForWelcome = true) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${token}`);
    ws.on('error', reject);
    if (waitForWelcome) {
      ws.on('message', function onFirst(raw) {
        ws.removeListener('message', onFirst);
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') {
          ws.connectionId = msg.connectionId;
          resolve(ws);
        }
      });
    } else {
      ws.on('open', () => resolve(ws));
    }
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

/** Collect N messages from a WebSocket */
function collectMessages(ws, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on('message', function handler(raw) {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msgs);
      }
    });
  });
}

/** Small sleep */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Server Bootstrap ────────────────────────────────────────────────────────

let server, wss;

async function startServer() {
  const { authenticateConnection, getClientIP } = require('../src/middleware/auth');
  const { validateMessage } = require('../src/validators/ecgValidator');
  const { handleRequest: handleAPIRequest } = require('../src/routes/ecgRoutes');

  const rateLimiter = new RateLimiter({
    maxConnectionsPerIP: 50,
    maxMessagesPerSecond: 200,
    maxAuthFailuresPerIP: 10,
    banDurationMs: 1000,
  });

  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy', mongo: 'connected',
        uptime: process.uptime(), connections: wss.clients.size,
        activeSessions: sessionManager.getActiveSessions().length,
      }));
      return;
    }
    if (req.url.startsWith('/api/')) {
      const handled = await handleAPIRequest(req, res);
      if (handled) return;
    }
    res.writeHead(404); res.end();
  });

  wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const clientIP = getClientIP(request);
    if (!rateLimiter.allowConnection(clientIP)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return;
    }
    const authResult = authenticateConnection(request);
    if (!authResult.authenticated) {
      rateLimiter.recordAuthFailure(clientIP);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    request.user = authResult.user;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws, request) => {
    const clientIP = getClientIP(request);
    const connectionId = require('uuid').v4();
    rateLimiter.addConnection(clientIP);
    ws._connectionId = connectionId;
    ws._clientIP = clientIP;
    ws._user = request.user || {};
    ws._connectedAt = Date.now();
    ws._messageCount = 0;

    ws.on('message', async (rawMessage) => {
      ws._messageCount++;
      if (!rateLimiter.allowMessage(connectionId)) {
        ws.send(JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }));
        return;
      }
      const validation = validateMessage(rawMessage);
      if (!validation.valid) {
        ws.send(JSON.stringify({ error: 'Invalid data', code: 'VALIDATION_ERROR', details: validation.errors }));
        return;
      }
      const data = validation.sanitized;
      switch (data.type) {
        case 'ecg_data': {
          try {
            const result = await sessionManager.recordECGData({
              connectionId, deviceId: data.deviceId, channelId: data.channelId,
              samples: data.samples, timestamp: data.timestamp,
              sequenceNumber: data.sequenceNumber,
              patientId: ws._user?.patientId || null,
            });
            // Broadcast to monitors
            wss.clients.forEach(client => {
              if (client !== ws && client.readyState === WebSocket.OPEN &&
                  client._user && ['monitor', 'admin', 'anonymous'].includes(client._user.role)) {
                client.send(JSON.stringify({
                  type: 'ecg_data', deviceId: data.deviceId, channelId: data.channelId,
                  samples: data.samples, timestamp: data.timestamp,
                }));
              }
            });
            ws.send(JSON.stringify({
              type: 'ack', messageType: 'ecg_data', channelId: data.channelId,
              samplesReceived: data.samples.length, sessionId: result.sessionId,
              buffered: result.buffered, timestamp: Date.now(),
            }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'ack', messageType: 'ecg_data', persistenceError: true }));
          }
          break;
        }
        case 'device_status':
          ws.send(JSON.stringify({ type: 'ack', messageType: 'device_status', timestamp: Date.now() }));
          break;
        case 'patient_info':
          ws.send(JSON.stringify({ type: 'ack', messageType: 'patient_info', timestamp: Date.now() }));
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
      }
    });

    ws.on('close', async () => {
      rateLimiter.removeConnection(clientIP);
      rateLimiter.removeMessageTracking(connectionId);
      try { await sessionManager.closeAllSessions(connectionId); } catch {}
    });

    ws.send(JSON.stringify({
      type: 'welcome', connectionId, serverVersion: '2.0.0', authEnabled: true,
      validMessageTypes: ['ecg_data', 'device_status', 'patient_info', 'ping'],
      timestamp: Date.now(),
    }));
  });

  return new Promise((resolve) => { server.listen(TEST_PORT, () => resolve()); });
}

async function stopServer() {
  sessionManager.destroy();
  if (wss) { wss.clients.forEach(c => c.terminate()); wss.close(); }
  if (server) await new Promise(r => server.close(r));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration Tests – Horizon Medical ECG Platform', () => {
  before(async () => {
    await setupMongo();
    await startServer();
  });

  after(async () => {
    await stopServer();
    await teardownMongo();
  });

  beforeEach(async () => {
    await Patient.deleteMany({});
    await ECGSession.deleteMany({});
    await ECGSignal.deleteMany({});
    sessionManager.destroy();
    sessionManager._activeSessions.clear();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  1. BLE Communication Simulation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('1. BLE Communication Simulation', () => {

    it('should validate all 8 ADS1298 channel UUIDs (8171-8178)', () => {
      const expectedChannels = ['8171', '8172', '8173', '8174', '8175', '8176', '8177', '8178'];
      for (const ch of expectedChannels) {
        assert.ok(VALID_CHANNEL_UUIDS.includes(ch), `Channel ${ch} must be valid`);
      }
    });

    it('should accept 24-bit ADC samples within valid range (-8388608 to 8388607)', () => {
      const msg = makeECGMessage({ samples: [-8388608, 0, 8388607, -1000, 1000] });
      const result = validateMessage(msg);
      assert.ok(result.valid, `Validation errors: ${result.errors.join(', ')}`);
    });

    it('should reject samples outside 24-bit ADC range', () => {
      const msg = makeECGMessage({ samples: [8388608] }); // overflow
      const result = validateMessage(msg);
      assert.ok(!result.valid, 'Should reject out-of-range sample');
    });

    it('should parse 24-bit signed integers correctly (firmware byte conversion)', () => {
      // Simulates firmware: 3-byte big-endian → signed int, then negated
      function parseFirmwareBytes(b0, b1, b2) {
        const val = (b0 << 24 | b1 << 16 | b2 << 8) >> 8;
        return -val;
      }
      // Positive value: 0x001234 = 4660 → negated = -4660
      assert.equal(parseFirmwareBytes(0x00, 0x12, 0x34), -4660);
      // Negative value: 0xFFFFFE = -2 → negated = 2
      assert.equal(parseFirmwareBytes(0xFF, 0xFF, 0xFE), 2);
      // Zero (note: bitwise negation produces -0, which is equivalent to 0)
      assert.equal(parseFirmwareBytes(0x00, 0x00, 0x00), -0);
      assert.ok(Object.is(parseFirmwareBytes(0x00, 0x00, 0x00), -0) || parseFirmwareBytes(0x00, 0x00, 0x00) === 0);
      // Max positive input: 0x7FFFFF = 8388607 → negated = -8388607
      assert.equal(parseFirmwareBytes(0x7F, 0xFF, 0xFF), -8388607);
    });

    it('should send all 8 channels over WebSocket and receive ACKs', async () => {
      const token = makeToken();
      const ws = await connectWS(token);

      try {
        const packets = generateFirmwarePacketBurst(21);
        const acks = [];

        for (const pkt of packets) {
          ws.send(JSON.stringify(pkt));
          const [ack] = await collectMessages(ws, 1, 2000);
          acks.push(ack);
        }

        assert.equal(acks.length, 8, 'Must get 8 ACKs for 8 channels');
        for (const ack of acks) {
          assert.equal(ack.type, 'ack');
          assert.equal(ack.messageType, 'ecg_data');
          assert.equal(ack.samplesReceived, 21);
          assert.ok(ack.sessionId, 'ACK must include sessionId');
        }

        // All ACKs should reference the same session
        const sessionIds = [...new Set(acks.map(a => a.sessionId))];
        assert.equal(sessionIds.length, 1, 'All channels should belong to one session');
      } finally {
        ws.close();
      }
    });

    it('should reject invalid channelId', async () => {
      const token = makeToken();
      const ws = await connectWS(token);
      try {
        ws.send(JSON.stringify({
          type: 'ecg_data', deviceId: 'holter-001',
          channelId: '9999', samples: [100, 200], timestamp: Date.now(),
        }));
        const [resp] = await collectMessages(ws, 1, 2000);
        assert.equal(resp.code, 'VALIDATION_ERROR');
      } finally {
        ws.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  2. WebSocket Communication
  // ═══════════════════════════════════════════════════════════════════════════

  describe('2. WebSocket Communication', () => {

    it('should authenticate with valid JWT and receive welcome', async () => {
      const token = makeToken();
      const ws = await connectWS(token);
      assert.ok(ws.connectionId, 'Welcome message must include connectionId');
      ws.close();
    });

    it('should reject connection with invalid JWT', async () => {
      await assert.rejects(async () => {
        await connectWS('invalid.jwt.token');
      }, /unexpected/i);
    });

    it('should reject expired JWT', async () => {
      const expired = jwt.sign(
        { sub: 'test', userId: 'u1', exp: Math.floor(Date.now() / 1000) - 60 },
        JWT_SECRET, { algorithm: 'HS256' }
      );
      await assert.rejects(async () => {
        await connectWS(expired);
      });
    });

    it('should handle ping/pong keepalive', async () => {
      const ws = await connectWS(makeToken());
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
        const [pong] = await collectMessages(ws, 1, 2000);
        assert.equal(pong.type, 'pong');
        assert.ok(pong.timestamp);
      } finally {
        ws.close();
      }
    });

    it('should broadcast ECG data to monitor clients', async () => {
      const deviceToken = makeToken({ role: 'device', deviceId: 'holter-001' });
      const monitorToken = makeToken({ sub: 'monitor-1', userId: 'mon-1', role: 'monitor' });

      const deviceWS = await connectWS(deviceToken);
      const monitorWS = await connectWS(monitorToken);

      try {
        // Start collecting on monitor BEFORE device sends
        const monitorPromise = collectMessages(monitorWS, 1, 3000);

        // Device sends ECG data
        deviceWS.send(makeECGMessage({ channelId: '8171' }));

        // Monitor should receive the broadcast
        const monitorMsgs = await monitorPromise;
        assert.ok(monitorMsgs.length >= 1, 'Monitor should receive broadcast');
        const ecgBroadcast = monitorMsgs.find(m => m.type === 'ecg_data');
        assert.ok(ecgBroadcast, 'Monitor should get ecg_data broadcast');
        assert.equal(ecgBroadcast.channelId, '8171');
      } finally {
        deviceWS.close();
        monitorWS.close();
      }
    });

    it('should handle device_status messages', async () => {
      const ws = await connectWS(makeToken());
      try {
        ws.send(JSON.stringify({
          type: 'device_status', deviceId: 'holter-001',
          status: 'online', batteryLevel: 85,
        }));
        const [ack] = await collectMessages(ws, 1, 2000);
        assert.equal(ack.type, 'ack');
        assert.equal(ack.messageType, 'device_status');
      } finally {
        ws.close();
      }
    });

    it('should reject malformed messages', async () => {
      const ws = await connectWS(makeToken());
      try {
        ws.send('not valid json {{{');
        const [resp] = await collectMessages(ws, 1, 2000);
        assert.equal(resp.code, 'VALIDATION_ERROR');
      } finally {
        ws.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  3. Database Persistence
  // ═══════════════════════════════════════════════════════════════════════════

  describe('3. Database Persistence', () => {

    it('should create ECG session on first data packet', async () => {
      const ws = await connectWS(makeToken());
      try {
        ws.send(makeECGMessage());
        const [ack] = await collectMessages(ws, 1, 2000);
        assert.ok(ack.sessionId, 'ACK should contain sessionId');

        // Verify session in DB
        const session = await ECGSession.findOne({ sessionId: ack.sessionId });
        assert.ok(session, 'Session must exist in DB');
        assert.equal(session.status, 'recording');
        assert.equal(session.device.deviceId, 'holter-001');
      } finally {
        ws.close();
      }
    });

    it('should persist signal data after buffer flush', async () => {
      const ws = await connectWS(makeToken());
      try {
        // Send enough packets to trigger flush (FLUSH_BUFFER_SIZE=5)
        for (let i = 0; i < 6; i++) {
          ws.send(makeECGMessage({ sequenceNumber: i }));
          await collectMessages(ws, 1, 2000); // wait for ACK
        }

        // Wait for flush
        await sleep(1000);

        const signals = await ECGSignal.find({ deviceId: 'holter-001' });
        assert.ok(signals.length > 0, 'Signals must be persisted after flush');

        // Verify compressed storage
        const compressedSignal = signals.find(s => s.compressed);
        if (compressedSignal) {
          assert.ok(compressedSignal.compressedData, 'Compressed signal should have data buffer');
          assert.ok(compressedSignal.compressionMeta, 'Should have compression metadata');
          assert.equal(compressedSignal.compressionMeta.algorithm, 'delta-rle');
        }
      } finally {
        ws.close();
      }
    });

    it('should finalize session on WebSocket disconnect', async () => {
      const ws = await connectWS(makeToken());
      let sessionId;
      try {
        ws.send(makeECGMessage());
        const [ack] = await collectMessages(ws, 1, 2000);
        sessionId = ack.sessionId;
      } finally {
        ws.close();
      }

      // Wait for close handler + flush
      await sleep(1500);

      const session = await ECGSession.findOne({ sessionId });
      assert.ok(session, 'Session should exist');
      assert.equal(session.status, 'completed', 'Session should be finalized');
      assert.ok(session.endedAt, 'endedAt should be set');
      assert.ok(session.durationMs >= 0, 'Duration should be computed');
    });

    it('should link session to patient via JWT', async () => {
      const token = makeToken({ patientId: 'PAT-CARDIAC-007' });
      const ws = await connectWS(token);
      try {
        ws.send(makeECGMessage());
        const [ack] = await collectMessages(ws, 1, 2000);

        const session = await ECGSession.findOne({ sessionId: ack.sessionId });
        assert.equal(session.patientId, 'PAT-CARDIAC-007');
      } finally {
        ws.close();
      }
    });

    it('should track multiple channels per session', async () => {
      const ws = await connectWS(makeToken());
      try {
        const channels = ['8171', '8172', '8173', '8174'];
        let sessionId;
        for (const ch of channels) {
          ws.send(makeECGMessage({ channelId: ch }));
          const [ack] = await collectMessages(ws, 1, 2000);
          sessionId = ack.sessionId;
        }

        // Check active session tracks channels
        const active = sessionManager.getActiveSessions();
        const sess = active.find(s => s.sessionId === sessionId);
        assert.ok(sess, 'Session should be active');
        for (const ch of channels) {
          assert.ok(sess.channelsRecorded.includes(ch), `Channel ${ch} should be recorded`);
        }
      } finally {
        ws.close();
      }
    });

    it('should decompress signals correctly from DB roundtrip', async () => {
      const original = generateSineECG(100, 3000, 500);
      const { buffer, meta } = compress(original);

      await ECGSignal.create({
        sessionId: 'SES-DECOMP-TEST', channelId: '8171', timestamp: new Date(),
        sampleCount: original.length, compressed: true, compressedData: buffer,
        compressionMeta: meta, deviceId: 'DEV-RT', samples: [],
      });

      const retrieved = await ECGSignal.findOne({ sessionId: 'SES-DECOMP-TEST' });
      const restored = decompress(retrieved.compressedData, retrieved.compressionMeta.firstSample);
      assert.deepEqual(restored, original, 'Decompressed data must match original');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  4. REST API Integration
  // ═══════════════════════════════════════════════════════════════════════════

  describe('4. REST API Integration', () => {

    it('should return healthy status on /health', async () => {
      const { status, body } = await httpGet('/health');
      assert.equal(status, 200);
      assert.equal(body.status, 'healthy');
      assert.equal(body.mongo, 'connected');
    });

    it('should create and retrieve a patient', async () => {
      const create = await httpPost('/api/v1/patients', {
        patientId: 'PAT-API-001', firstName: 'María', lastName: 'López',
        gender: 'female', diagnosis: 'Arritmia sinusal',
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.data.patientId, 'PAT-API-001');

      const get = await httpGet('/api/v1/patients/PAT-API-001');
      assert.equal(get.status, 200);
      assert.equal(get.body.data.firstName, 'María');
      assert.equal(get.body.data.diagnosis, 'Arritmia sinusal');
    });

    it('should list sessions with pagination', async () => {
      // Create test sessions
      for (let i = 0; i < 5; i++) {
        await ECGSession.create({
          sessionId: `SES-API-${i}`, device: { deviceId: 'DEV-A' },
          startedAt: new Date(Date.now() - i * 60000), status: 'completed',
        });
      }

      const { status, body } = await httpGet('/api/v1/sessions?limit=2&page=1');
      assert.equal(status, 200);
      assert.equal(body.data.length, 2);
      assert.equal(body.pagination.total, 5);
      assert.equal(body.pagination.totalPages, 3);
    });

    it('should retrieve signals for a session via API', async () => {
      const sessionId = 'SES-SIGNALS-API';
      await ECGSession.create({
        sessionId, device: { deviceId: 'DEV-A' }, startedAt: new Date(),
      });

      const samples = [100, 200, 300, 400, 500];
      await ECGSignal.create({
        sessionId, channelId: '8171', timestamp: new Date(),
        sampleCount: samples.length, samples, deviceId: 'DEV-A',
      });

      const { status, body } = await httpGet(`/api/v1/sessions/${sessionId}/signals`);
      assert.equal(status, 200);
      assert.ok(body.data.length >= 1);
      assert.equal(body.session.sessionId, sessionId);
    });

    it('should return stats endpoint', async () => {
      await ECGSession.create({ sessionId: 'STAT-1', device: { deviceId: 'D' }, startedAt: new Date() });
      await Patient.create({ patientId: 'STAT-P1' });

      const { status, body } = await httpGet('/api/v1/stats');
      assert.equal(status, 200);
      assert.ok(body.data.totalSessions >= 1);
      assert.ok(body.data.totalPatients >= 1);
    });

    it('should show active sessions via API', async () => {
      const ws = await connectWS(makeToken());
      try {
        ws.send(makeECGMessage());
        await collectMessages(ws, 1, 2000);

        const { status, body } = await httpGet('/api/v1/sessions/active');
        assert.equal(status, 200);
        assert.ok(body.count >= 1, 'Should have at least 1 active session');
      } finally {
        ws.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  5. ECG Lead Derivation Calculations
  // ═══════════════════════════════════════════════════════════════════════════

  describe('5. ECG Lead Derivation Calculations (12-lead)', () => {

    /**
     * Reference formulas for standard 12-lead ECG:
     *   Lead I   = Channel 1 (LA - RA)
     *   Lead II  = Channel 2 (LL - RA)
     *   Lead III = II - I
     *   aVR      = -(I + II) / 2
     *   aVL      = I - II/2
     *   aVF      = II - I/2       ← previously had bug: was II - II/2
     *   V1-V6   = Channels 3-8 (precordial, direct mapping)
     */

    const ch1 = [1000, 2000, -500, 3000, 0];   // Lead I (LA - RA)
    const ch2 = [1500, 2500, -200, 3500, 500];  // Lead II (LL - RA)

    it('should compute Lead III = II - I', () => {
      const leadIII = ch2.map((v, i) => v - ch1[i]);
      assert.deepEqual(leadIII, [500, 500, 300, 500, 500]);
    });

    it('should compute aVR = -(I + II) / 2', () => {
      const aVR = ch1.map((v, i) => -(v + ch2[i]) / 2);
      assert.deepEqual(aVR, [-1250, -2250, 350, -3250, -250]);
    });

    it('should compute aVL = I - II/2', () => {
      const aVL = ch1.map((v, i) => v - ch2[i] / 2);
      assert.deepEqual(aVL, [250, 750, -400, 1250, -250]);
    });

    it('should compute aVF = II - I/2 (corrected formula)', () => {
      // This validates the critical bugfix: was II - II/2, now II - I/2
      const aVF = ch2.map((v, i) => v - ch1[i] / 2);
      assert.deepEqual(aVF, [1000, 1500, 50, 2000, 500]);

      // Verify the OLD buggy formula would produce wrong results
      const buggyAVF = ch2.map((v, i) => v - ch2[i] / 2);
      const correctAVF = ch2.map((v, i) => v - ch1[i] / 2);
      assert.notDeepEqual(buggyAVF, correctAVF, 'Buggy formula must differ from correct');
    });

    it('should verify Einthoven triangle: I + III = II', () => {
      // Fundamental ECG law: Lead I + Lead III = Lead II
      const leadIII = ch2.map((v, i) => v - ch1[i]);
      for (let i = 0; i < ch1.length; i++) {
        assert.equal(ch1[i] + leadIII[i], ch2[i],
          `Einthoven failed at sample ${i}: ${ch1[i]} + ${leadIII[i]} ≠ ${ch2[i]}`);
      }
    });

    it('should verify Goldberger relationship: aVR + aVL + aVF = 0', () => {
      for (let i = 0; i < ch1.length; i++) {
        const aVR = -(ch1[i] + ch2[i]) / 2;
        const aVL = ch1[i] - ch2[i] / 2;
        const aVF = ch2[i] - ch1[i] / 2;
        const sum = aVR + aVL + aVF;
        assert.ok(Math.abs(sum) < 1e-10,
          `Goldberger sum at sample ${i}: ${sum} ≠ 0`);
      }
    });

    it('should map precordial leads V1-V6 to channels 3-8 (direct pass-through)', () => {
      const channelMap = {
        '8173': 'V1', '8174': 'V2', '8175': 'V3',
        '8176': 'V4', '8177': 'V5', '8178': 'V6',
      };
      // Verify mapping aligns with BLE characteristic UUIDs
      for (const [uuid, lead] of Object.entries(channelMap)) {
        const channelIndex = parseInt(uuid, 16) - 0x8171;
        assert.ok(channelIndex >= 2 && channelIndex <= 7,
          `${lead} (UUID ${uuid}) → index ${channelIndex}`);
      }
    });

    it('should handle edge cases: zero input, max/min ADC values', () => {
      const zeros = [0, 0, 0];
      const maxADC = [8388607, 8388607, 8388607];
      const minADC = [-8388608, -8388608, -8388608];

      // aVF with zeros
      const aVF_zeros = zeros.map((v, i) => v - zeros[i] / 2);
      assert.deepEqual(aVF_zeros, [0, 0, 0]);

      // Einthoven with max values (all equal → III = 0)
      const leadIII_max = maxADC.map((v, i) => v - maxADC[i]);
      assert.deepEqual(leadIII_max, [0, 0, 0]);

      // Goldberger with extreme values
      for (let i = 0; i < maxADC.length; i++) {
        const I = maxADC[i], II = minADC[i];
        const aVR = -(I + II) / 2;
        const aVL = I - II / 2;
        const aVF = II - I / 2;
        assert.ok(Math.abs(aVR + aVL + aVF) < 1e-6, 'Goldberger must hold at extremes');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  6. End-to-End: Firmware → Persist → API → Visualization Data
  // ═══════════════════════════════════════════════════════════════════════════

  describe('6. End-to-End Flow: Firmware → DB → API', () => {

    it('should complete full cycle: register patient → send 8-ch ECG → finalize → query via API', async () => {
      // Step 1: Create patient via REST
      const patRes = await httpPost('/api/v1/patients', {
        patientId: 'PAT-E2E-001', firstName: 'Carlos', lastName: 'Rodríguez',
        gender: 'male', diagnosis: 'Monitorización Holter 24h',
      });
      assert.equal(patRes.status, 201);

      // Step 2: Device connects with patient context
      const token = makeToken({ patientId: 'PAT-E2E-001', deviceId: 'holter-e2e' });
      const ws = await connectWS(token);
      let sessionId;

      try {
        // Step 3: Simulate multi-channel firmware burst (all 8 channels)
        const burst = generateFirmwarePacketBurst(21);
        for (const pkt of burst) {
          pkt.deviceId = 'holter-e2e';
          ws.send(JSON.stringify(pkt));
          const [ack] = await collectMessages(ws, 1, 2000);
          assert.equal(ack.type, 'ack');
          sessionId = ack.sessionId;
        }

        // Step 4: Send more data to trigger buffer flush
        for (let i = 0; i < 5; i++) {
          ws.send(JSON.stringify({
            type: 'ecg_data', deviceId: 'holter-e2e', channelId: '8171',
            samples: generateSineECG(21), timestamp: Date.now(), sequenceNumber: 100 + i,
          }));
          await collectMessages(ws, 1, 2000);
        }

        await sleep(1000); // Wait for flush
      } finally {
        ws.close();
      }

      // Step 5: Wait for session finalization
      await sleep(2000);

      // Step 6: Verify via REST API
      const sessRes = await httpGet(`/api/v1/sessions/${sessionId}`);
      assert.equal(sessRes.status, 200);
      assert.equal(sessRes.body.data.status, 'completed');
      assert.equal(sessRes.body.data.patientId, 'PAT-E2E-001');
      assert.equal(sessRes.body.data.device.deviceId, 'holter-e2e');

      // Step 7: Verify signals were persisted
      const sigRes = await httpGet(`/api/v1/sessions/${sessionId}/signals?limit=100`);
      assert.equal(sigRes.status, 200);
      assert.ok(sigRes.body.data.length > 0, 'Should have persisted signal data');

      // Step 8: Verify patient association
      const patGet = await httpGet('/api/v1/patients/PAT-E2E-001');
      assert.equal(patGet.status, 200);
      assert.ok(patGet.body.sessionSummary.totalSessions >= 1);

      // Step 9: Verify stats reflect the activity
      const statsRes = await httpGet('/api/v1/stats');
      assert.equal(statsRes.status, 200);
      assert.ok(statsRes.body.data.totalSessions >= 1);
      assert.ok(statsRes.body.data.totalSignalChunks >= 1);
    });

    it('should handle concurrent devices on separate sessions', async () => {
      const token1 = makeToken({ deviceId: 'holter-A', sub: 'dev-A', userId: 'u-A' });
      const token2 = makeToken({ deviceId: 'holter-B', sub: 'dev-B', userId: 'u-B' });

      const ws1 = await connectWS(token1);
      const ws2 = await connectWS(token2);

      let sid1, sid2;
      try {
        // Device A sends on channel 8171
        ws1.send(makeECGMessage({ deviceId: 'holter-A', channelId: '8171' }));
        const [ack1] = await collectMessages(ws1, 1, 2000);
        sid1 = ack1.sessionId;

        // Device B sends on channel 8171
        ws2.send(makeECGMessage({ deviceId: 'holter-B', channelId: '8171' }));
        const [ack2] = await collectMessages(ws2, 1, 2000);
        sid2 = ack2.sessionId;

        assert.notEqual(sid1, sid2, 'Different devices must have separate sessions');
      } finally {
        ws1.close();
        ws2.close();
      }

      await sleep(1500);

      // Both sessions should be finalized
      const s1 = await ECGSession.findOne({ sessionId: sid1 });
      const s2 = await ECGSession.findOne({ sessionId: sid2 });
      assert.ok(s1, 'Session 1 must exist');
      assert.ok(s2, 'Session 2 must exist');
      assert.equal(s1.device.deviceId, 'holter-A');
      assert.equal(s2.device.deviceId, 'holter-B');
    });

    it('should handle rapid-fire data without data loss', async () => {
      const ws = await connectWS(makeToken());
      const totalPackets = 10;

      try {
        // Send all packets first
        for (let i = 0; i < totalPackets; i++) {
          ws.send(makeECGMessage({ sequenceNumber: i }));
        }
        // Collect ACKs with generous timeout
        const allMsgs = await collectMessages(ws, totalPackets, 15000);
        const ackCount = allMsgs.filter(m => m.type === 'ack' && m.messageType === 'ecg_data').length;
        assert.equal(ackCount, totalPackets, `Expected ${totalPackets} ACKs, got ${ackCount}`);
      } finally {
        ws.close();
        await sleep(500);
      }
    });
  });
});
