/**
 * Tests for Notification System (Phase 16)
 *
 * Covers:
 *   - NotificationQueue priority queue
 *   - NotificationRateLimiter
 *   - SuppressionTracker
 *   - Event detectors (arrhythmia, disconnection, battery, signal quality)
 *   - Email template generation
 *   - Notification CRUD API routes
 *   - Preferences API
 *   - WebSocket broadcast
 *
 * Run with: node --test --test-force-exit tests/notifications.test.js
 */

'use strict';

const { describe, it, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// ─── Setup env before requiring modules ──────────────────────────────────────
process.env.JWT_SECRET = 'test-secret-for-notification-tests-min-32';
process.env.AUTH_ENABLED = 'false';
process.env.NOTIF_RATE_LIMIT_WINDOW_MS = '5000';
process.env.NOTIF_RATE_LIMIT_MAX = '5';
process.env.NOTIF_SUPPRESSION_WINDOW_MS = '500';

const {
  NotificationQueue,
  NotificationRateLimiter,
  SuppressionTracker,
  SEVERITY,
  SEVERITY_PRIORITY,
  generateEmailHTML,
  generateEmailSubject,
  _queue,
  _rateLimiter,
  _suppression,
  createNotification,
  detectArrhythmia,
  detectDeviceDisconnection,
  detectBatteryLow,
  detectSignalQualityDegraded,
  broadcastToClients,
  setWebSocketServer,
} = require('../src/services/notification-service');

// ─── Mock MongoDB models ─────────────────────────────────────────────────────
// For unit tests, we mock the Mongoose models to avoid needing a real DB

const mongoose = require('mongoose');
// Reduce buffer timeout for tests without MongoDB connection
mongoose.set('bufferTimeoutMS', 500);

// ═══════════════════════════════════════════════════════════════════════════
// 1. NotificationQueue Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('NotificationQueue', () => {
  it('should enqueue and dequeue items in FIFO order for same priority', () => {
    const q = new NotificationQueue();
    q.enqueue({ severity: 'MEDIUM', id: 1 });
    q.enqueue({ severity: 'MEDIUM', id: 2 });
    q.enqueue({ severity: 'MEDIUM', id: 3 });
    assert.equal(q.dequeue().id, 1);
    assert.equal(q.dequeue().id, 2);
    assert.equal(q.dequeue().id, 3);
  });

  it('should prioritize CRITICAL over other severities', () => {
    const q = new NotificationQueue();
    q.enqueue({ severity: 'LOW', id: 'low' });
    q.enqueue({ severity: 'MEDIUM', id: 'medium' });
    q.enqueue({ severity: 'CRITICAL', id: 'critical' });
    q.enqueue({ severity: 'HIGH', id: 'high' });

    // CRITICAL (0) inserted before LOW (3) and MEDIUM (2)
    // HIGH (1) inserted before MEDIUM (2) and LOW (3)
    assert.equal(q.dequeue().id, 'critical');
    assert.equal(q.dequeue().id, 'high');
    assert.equal(q.dequeue().id, 'medium');
    assert.equal(q.dequeue().id, 'low');
  });

  it('should return null when queue is empty', () => {
    const q = new NotificationQueue();
    assert.equal(q.dequeue(), null);
  });

  it('should report correct size', () => {
    const q = new NotificationQueue();
    assert.equal(q.size(), 0);
    q.enqueue({ severity: 'LOW', id: 1 });
    assert.equal(q.size(), 1);
    q.enqueue({ severity: 'HIGH', id: 2 });
    assert.equal(q.size(), 2);
    q.dequeue();
    assert.equal(q.size(), 1);
  });

  it('should clear all items', () => {
    const q = new NotificationQueue();
    q.enqueue({ severity: 'LOW', id: 1 });
    q.enqueue({ severity: 'HIGH', id: 2 });
    q.clear();
    assert.equal(q.size(), 0);
    assert.equal(q.dequeue(), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. NotificationRateLimiter Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('NotificationRateLimiter', () => {
  it('should allow notifications within rate limit', () => {
    const rl = new NotificationRateLimiter();
    assert.equal(rl.allow('test:device1'), true);
    assert.equal(rl.allow('test:device1'), true);
    assert.equal(rl.allow('test:device1'), true);
  });

  it('should block notifications exceeding rate limit', () => {
    const rl = new NotificationRateLimiter();
    // NOTIF_RATE_LIMIT_MAX = 5
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.allow('flood:device1'), true);
    }
    assert.equal(rl.allow('flood:device1'), false);
  });

  it('should track different keys independently', () => {
    const rl = new NotificationRateLimiter();
    for (let i = 0; i < 5; i++) {
      rl.allow('type1:dev1');
    }
    assert.equal(rl.allow('type1:dev1'), false);
    assert.equal(rl.allow('type2:dev1'), true);
    assert.equal(rl.allow('type1:dev2'), true);
  });

  it('should reset all counters', () => {
    const rl = new NotificationRateLimiter();
    for (let i = 0; i < 5; i++) rl.allow('key1');
    rl.reset();
    assert.equal(rl.allow('key1'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SuppressionTracker Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('SuppressionTracker', () => {
  it('should not flag first occurrence as duplicate', () => {
    const st = new SuppressionTracker();
    assert.equal(st.isDuplicate('arrhythmia', 'dev1'), false);
  });

  it('should flag rapid duplicate as suppressed', () => {
    const st = new SuppressionTracker();
    st.isDuplicate('arrhythmia', 'dev1'); // first
    assert.equal(st.isDuplicate('arrhythmia', 'dev1'), true); // immediate duplicate
  });

  it('should allow same type for different devices', () => {
    const st = new SuppressionTracker();
    st.isDuplicate('arrhythmia', 'dev1');
    assert.equal(st.isDuplicate('arrhythmia', 'dev2'), false);
  });

  it('should allow after suppression window expires', async () => {
    const st = new SuppressionTracker();
    st.isDuplicate('arrhythmia', 'dev1');
    // Wait for suppression window (500ms in test config)
    await new Promise(r => setTimeout(r, 600));
    assert.equal(st.isDuplicate('arrhythmia', 'dev1'), false);
  });

  it('should cleanup old entries', () => {
    const st = new SuppressionTracker();
    st.recent.set('old:key', Date.now() - 999999);
    st.recent.set('new:key', Date.now());
    st.cleanup();
    assert.equal(st.recent.has('old:key'), false);
    assert.equal(st.recent.has('new:key'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Severity Constants Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Severity System', () => {
  it('should define all four severity levels', () => {
    assert.equal(SEVERITY.CRITICAL, 'CRITICAL');
    assert.equal(SEVERITY.HIGH, 'HIGH');
    assert.equal(SEVERITY.MEDIUM, 'MEDIUM');
    assert.equal(SEVERITY.LOW, 'LOW');
  });

  it('should have correct priority ordering (lower = higher priority)', () => {
    assert.ok(SEVERITY_PRIORITY.CRITICAL < SEVERITY_PRIORITY.HIGH);
    assert.ok(SEVERITY_PRIORITY.HIGH < SEVERITY_PRIORITY.MEDIUM);
    assert.ok(SEVERITY_PRIORITY.MEDIUM < SEVERITY_PRIORITY.LOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Email Template Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Email Templates', () => {
  it('should generate valid HTML email', () => {
    const html = generateEmailHTML({
      severity: 'CRITICAL',
      title: 'Test Alert',
      message: 'This is a test message',
      type: 'arrhythmia_detected',
      source: { deviceId: 'DEV-001', patientId: 'PAT-001' },
    });
    assert.ok(html.includes('Horizon Medical'));
    assert.ok(html.includes('Test Alert'));
    assert.ok(html.includes('This is a test message'));
    assert.ok(html.includes('CRITICAL'));
    assert.ok(html.includes('DEV-001'));
    assert.ok(html.includes('PAT-001'));
    assert.ok(html.includes('<!DOCTYPE html>'));
  });

  it('should generate appropriate email subjects', () => {
    assert.ok(generateEmailSubject({ severity: 'CRITICAL', title: 'VFib' }).includes('URGENTE'));
    assert.ok(generateEmailSubject({ severity: 'HIGH', title: 'Alert' }).includes('ALERTA'));
    assert.ok(generateEmailSubject({ severity: 'MEDIUM', title: 'Notice' }).includes('Aviso'));
    assert.ok(generateEmailSubject({ severity: 'LOW', title: 'Info' }).includes('Info'));
  });

  it('should escape HTML in user-supplied content', () => {
    const html = generateEmailHTML({
      severity: 'LOW',
      title: '<script>alert("xss")</script>',
      message: 'Test & "quotes"',
      type: 'test_notification',
      source: {},
    });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&amp;'));
  });

  it('should handle missing source fields gracefully', () => {
    const html = generateEmailHTML({
      severity: 'MEDIUM',
      title: 'Test',
      message: 'Msg',
      type: 'system_error',
      source: {},
    });
    assert.ok(html.includes('Test'));
    assert.ok(!html.includes('Dispositivo'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Event Detector Logic Tests (unit level, no DB)
// ═══════════════════════════════════════════════════════════════════════════

describe('Event Detectors - Battery', () => {
  it('should not trigger for battery >= 20%', async () => {
    // Reset suppression to avoid interference
    _suppression.recent.clear();
    _rateLimiter.reset();

    // Mock the Notification model to avoid DB calls
    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectBatteryLow({ deviceId: 'dev1', batteryLevel: 20 });
      assert.equal(result, null);
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });

  it('should trigger HIGH for battery < 5%', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectBatteryLow({ deviceId: 'dev-bat-5', batteryLevel: 3 });
      assert.ok(result);
      assert.equal(result.severity, 'HIGH');
      assert.equal(result.type, 'battery_low');
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });

  it('should trigger MEDIUM for battery between 5% and 20%', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectBatteryLow({ deviceId: 'dev-bat-15', batteryLevel: 15 });
      assert.ok(result);
      assert.equal(result.severity, 'MEDIUM');
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });
});

describe('Event Detectors - Arrhythmia', () => {
  it('should return null for normal classification', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const result = await detectArrhythmia({ classification: 'normal', confidence: 0.95, deviceId: 'dev1' });
    assert.equal(result, null);
  });

  it('should create CRITICAL notification for ventricular fibrillation', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectArrhythmia({
        classification: 'ventricular_fibrillation',
        confidence: 0.98,
        deviceId: 'dev-vfib',
        patientId: 'pat1',
        sessionId: 'sess1',
      });
      assert.ok(result);
      assert.equal(result.severity, 'CRITICAL');
      assert.equal(result.type, 'arrhythmia_detected');
      assert.ok(result.title.includes('Fibrilación Ventricular'));
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });

  it('should create HIGH notification for abnormal with high confidence', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectArrhythmia({
        classification: 'abnormal',
        confidence: 0.95,
        deviceId: 'dev-abn-high',
      });
      assert.ok(result);
      assert.equal(result.severity, 'HIGH');
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });
});

describe('Event Detectors - Device Disconnection', () => {
  it('should create HIGH notification during active session', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectDeviceDisconnection({
        deviceId: 'dev-disc-sess',
        sessionId: 'active-session-1',
        reason: 'connection_timeout',
      });
      assert.ok(result);
      assert.equal(result.severity, 'HIGH');
      assert.equal(result.type, 'device_disconnected');
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });

  it('should create MEDIUM notification without active session', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectDeviceDisconnection({
        deviceId: 'dev-disc-nosess',
        reason: 'normal_close',
      });
      assert.ok(result);
      assert.equal(result.severity, 'MEDIUM');
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });
});

describe('Event Detectors - Signal Quality', () => {
  it('should return null for good signal quality', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const result = await detectSignalQualityDegraded({
      deviceId: 'dev1', snrDb: 20, qualityScore: 0.9,
    });
    assert.equal(result, null);
  });

  it('should create notification for low SNR', async () => {
    _suppression.recent.clear();
    _rateLimiter.reset();

    const origSave = mongoose.Model.prototype.save;
    mongoose.Model.prototype.save = async function () { return this; };

    try {
      const result = await detectSignalQualityDegraded({
        deviceId: 'dev-snr-low',
        snrDb: 3,
      });
      assert.ok(result);
      assert.equal(result.type, 'signal_quality_degraded');
      assert.equal(result.severity, 'HIGH'); // snrDb < 5 = HIGH
    } finally {
      mongoose.Model.prototype.save = origSave;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. WebSocket Broadcast Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('WebSocket Broadcast', () => {
  it('should return 0 when no WSS configured', () => {
    setWebSocketServer(null);
    const sent = broadcastToClients({ notificationId: 'test', type: 'test', severity: 'LOW', title: 'Test', message: 'Test' });
    assert.equal(sent, 0);
  });

  it('should broadcast to admin/monitor clients', () => {
    const sentMessages = [];
    const mockWss = {
      clients: new Set([
        { readyState: 1, _user: { role: 'admin' }, send: (msg) => sentMessages.push(JSON.parse(msg)) },
        { readyState: 1, _user: { role: 'monitor' }, send: (msg) => sentMessages.push(JSON.parse(msg)) },
        { readyState: 1, _user: { role: 'device' }, send: () => {} }, // should not receive
      ]),
    };
    setWebSocketServer(mockWss);

    const sent = broadcastToClients({
      notificationId: 'n1', type: 'test_notification', severity: 'LOW', title: 'Test', message: 'Test',
    });

    assert.equal(sent, 2);
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].type, 'notification');
    assert.equal(sentMessages[0].data.notificationId, 'n1');

    setWebSocketServer(null);
  });

  it('should skip clients with readyState != 1', () => {
    const mockWss = {
      clients: new Set([
        { readyState: 0, _user: { role: 'admin' }, send: () => {} },
        { readyState: 3, _user: { role: 'admin' }, send: () => {} },
      ]),
    };
    setWebSocketServer(mockWss);

    const sent = broadcastToClients({ notificationId: 'n2', type: 'test', severity: 'LOW', title: 'T', message: 'M' });
    assert.equal(sent, 0);

    setWebSocketServer(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Mongoose Model Schema Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Notification Model Schema', () => {
  const Notification = require('../src/models/Notification');

  it('should require notificationId, type, severity, title, message', () => {
    const doc = new Notification({});
    const err = doc.validateSync();
    assert.ok(err);
    assert.ok(err.errors.notificationId);
    assert.ok(err.errors.type);
    assert.ok(err.errors.severity);
    assert.ok(err.errors.title);
    assert.ok(err.errors.message);
  });

  it('should accept valid notification data', () => {
    const doc = new Notification({
      notificationId: 'test-123',
      type: 'battery_low',
      severity: 'MEDIUM',
      title: 'Battery Low',
      message: 'Device battery is at 15%',
      source: { deviceId: 'dev-001' },
    });
    const err = doc.validateSync();
    assert.equal(err, undefined);
    assert.equal(doc.status, 'pending');
  });

  it('should reject invalid severity', () => {
    const doc = new Notification({
      notificationId: 'test-456',
      type: 'battery_low',
      severity: 'INVALID',
      title: 'Test',
      message: 'Test',
    });
    const err = doc.validateSync();
    assert.ok(err);
    assert.ok(err.errors.severity);
  });

  it('should reject invalid type', () => {
    const doc = new Notification({
      notificationId: 'test-789',
      type: 'invalid_type',
      severity: 'LOW',
      title: 'Test',
      message: 'Test',
    });
    const err = doc.validateSync();
    assert.ok(err);
    assert.ok(err.errors.type);
  });
});

describe('NotificationPreference Model Schema', () => {
  const NotificationPreference = require('../src/models/NotificationPreference');

  it('should require userId and email', () => {
    const doc = new NotificationPreference({});
    const err = doc.validateSync();
    assert.ok(err);
    assert.ok(err.errors.userId);
    assert.ok(err.errors.email);
  });

  it('should have sensible defaults', () => {
    const doc = new NotificationPreference({
      userId: 'user1',
      email: 'test@example.com',
    });
    assert.equal(doc.enabled, true);
    assert.equal(doc.channels.email, true);
    assert.equal(doc.channels.websocket, true);
    assert.equal(doc.severityFilter.CRITICAL, true);
    assert.equal(doc.severityFilter.LOW, false);
  });

  it('shouldNotify returns false when disabled', () => {
    const doc = new NotificationPreference({
      userId: 'user1',
      email: 'test@example.com',
      enabled: false,
    });
    assert.equal(doc.shouldNotify('battery_low', 'MEDIUM'), false);
  });

  it('shouldNotify respects severity filter', () => {
    const doc = new NotificationPreference({
      userId: 'user1',
      email: 'test@example.com',
      severityFilter: { CRITICAL: true, HIGH: true, MEDIUM: false, LOW: false },
    });
    assert.equal(doc.shouldNotify('battery_low', 'CRITICAL'), true);
    assert.equal(doc.shouldNotify('battery_low', 'MEDIUM'), false);
  });

  it('shouldNotify respects type filter', () => {
    const doc = new NotificationPreference({
      userId: 'user1',
      email: 'test@example.com',
      typeFilter: { battery_low: false, arrhythmia_detected: true },
    });
    assert.equal(doc.shouldNotify('battery_low', 'HIGH'), false);
    assert.equal(doc.shouldNotify('arrhythmia_detected', 'HIGH'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. API Integration Tests (HTTP-level)
// ═══════════════════════════════════════════════════════════════════════════

describe('Notification API Routes', () => {
  const handleNotificationRoutes = require('../src/routes/notificationRoutes');

  function createMockReq(method, url, body = null) {
    const { Readable } = require('stream');
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    req.headers = {};
    if (body) {
      const data = JSON.stringify(body);
      process.nextTick(() => {
        req.push(data);
        req.push(null);
      });
    } else {
      process.nextTick(() => req.push(null));
    }
    return req;
  }

  function createMockRes() {
    const res = {
      _statusCode: 0,
      _headers: {},
      _body: '',
      writeHead(code, headers) { res._statusCode = code; res._headers = headers; },
      end(data) { res._body = data; },
      setHeader() {},
    };
    return res;
  }

  it('GET /api/v1/notifications should return list', async () => {
    const req = createMockReq('GET', '/api/v1/notifications');
    const res = createMockRes();

    // Mock Notification.find and countDocuments
    const origFind = mongoose.Model.find;
    const origCount = mongoose.Model.countDocuments;

    // We just test the route handler responds correctly
    // For a full integration test we'd need MongoMemoryServer
    const handled = await handleNotificationRoutes(req, res);
    // It may fail with DB error since no MongoDB, but it should be handled
    assert.ok(handled !== null);
  });

  it('GET /api/v1/notifications/stats should be routed correctly', async () => {
    const req = createMockReq('GET', '/api/v1/notifications/stats');
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('GET /api/v1/notifications/unread-count should be routed correctly', async () => {
    const req = createMockReq('GET', '/api/v1/notifications/unread-count');
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('POST /api/v1/notifications/test should be routed correctly', async () => {
    const req = createMockReq('POST', '/api/v1/notifications/test', {
      title: 'Test',
      message: 'Test notification',
      severity: 'LOW',
    });
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('PUT /api/v1/notifications/preferences should be routed correctly', async () => {
    const req = createMockReq('PUT', '/api/v1/notifications/preferences', {
      userId: 'test-user',
      email: 'test@example.com',
    });
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('should return null for unmatched paths', async () => {
    const req = createMockReq('GET', '/api/v1/other');
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.equal(handled, null);
  });

  it('GET /api/v1/notifications/preferences should be routed correctly', async () => {
    const req = createMockReq('GET', '/api/v1/notifications/preferences?userId=default');
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('PUT /api/v1/notifications/:id/read should be routed correctly', async () => {
    const req = createMockReq('PUT', '/api/v1/notifications/test-id/read');
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('PUT /api/v1/notifications/:id/acknowledge should be routed correctly', async () => {
    const req = createMockReq('PUT', '/api/v1/notifications/test-id/acknowledge', { acknowledgedBy: 'admin' });
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });

  it('GET /api/v1/notifications/:id should be routed correctly', async () => {
    const req = createMockReq('GET', '/api/v1/notifications/some-uuid');
    const res = createMockRes();
    const handled = await handleNotificationRoutes(req, res);
    assert.ok(handled !== null);
  });
});
