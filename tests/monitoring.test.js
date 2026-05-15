/**
 * @file monitoring.test.js
 * @description Tests for the monitoring system: MetricsCollector, AlertManager, and monitoring routes.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── MetricsCollector Tests ──────────────────────────────────────────────────

describe('MetricsCollector', () => {
  let metricsCollector;

  beforeEach(() => {
    metricsCollector = require('../src/services/metricsCollector');
    metricsCollector.reset();
  });

  afterEach(() => {
    metricsCollector.stop();
  });

  describe('Connection tracking', () => {
    it('should record connections and track current count', () => {
      metricsCollector.recordConnection('device');
      metricsCollector.recordConnection('monitor');
      metricsCollector.recordConnection('device');

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.connections.current, 3);
      assert.equal(snapshot.connections.total, 3);
      assert.equal(snapshot.connections.byRole.device, 2);
      assert.equal(snapshot.connections.byRole.monitor, 1);
      assert.equal(snapshot.connections.peak, 3);
    });

    it('should record disconnections correctly', () => {
      metricsCollector.recordConnection('device');
      metricsCollector.recordConnection('device');
      metricsCollector.recordDisconnection('device');

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.connections.current, 1);
      assert.equal(snapshot.connections.total, 2);
      assert.equal(snapshot.connections.byRole.device, 1);
      assert.equal(snapshot.connections.peak, 2);
    });

    it('should not go below zero on disconnection', () => {
      metricsCollector.recordDisconnection('device');
      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.connections.current, 0);
    });

    it('should track rejected connections', () => {
      metricsCollector.recordRejectedConnection('auth');
      metricsCollector.recordRejectedConnection('rate_limit');

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.connections.rejected, 2);
      assert.equal(snapshot.errors.total, 2);
    });
  });

  describe('Message tracking', () => {
    it('should record messages by type', () => {
      metricsCollector.recordMessage('ecg_data', 500);
      metricsCollector.recordMessage('ecg_data', 600);
      metricsCollector.recordMessage('device_status', 100);

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.messages.received, 3);
      assert.equal(snapshot.messages.byType.ecg_data, 2);
      assert.equal(snapshot.messages.byType.device_status, 1);
      assert.equal(snapshot.messages.bytesReceived, 1200);
    });

    it('should track processed and rate-limited messages', () => {
      metricsCollector.recordProcessedMessage();
      metricsCollector.recordProcessedMessage();
      metricsCollector.recordRateLimitedMessage();

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.messages.processed, 2);
      assert.equal(snapshot.messages.rateLimited, 1);
    });
  });

  describe('Latency tracking', () => {
    it('should calculate latency statistics', () => {
      const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      latencies.forEach(l => metricsCollector.recordLatency(l));

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.latency.min, 1);
      assert.equal(snapshot.latency.max, 10);
      assert.equal(snapshot.latency.avg, 5.5);
      assert.equal(snapshot.latency.sampleCount, 10);
      assert.ok(snapshot.latency.p95 >= 9);
    });

    it('should handle empty latency data', () => {
      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.latency.min, 0);
      assert.equal(snapshot.latency.max, 0);
      assert.equal(snapshot.latency.avg, 0);
    });
  });

  describe('Error tracking', () => {
    it('should record errors by category', () => {
      metricsCollector.recordError('validation', 'Invalid JSON');
      metricsCollector.recordError('validation', 'Missing field');
      metricsCollector.recordError('websocket', 'Connection reset');

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.errors.total, 3);
      assert.equal(snapshot.errors.byCategory.validation, 2);
      assert.equal(snapshot.errors.byCategory.websocket, 1);
      assert.ok(snapshot.errors.recent.length <= 10);
    });

    it('should keep recent errors capped', () => {
      for (let i = 0; i < 100; i++) {
        metricsCollector.recordError('test', `Error ${i}`);
      }
      const snapshot = metricsCollector.getSnapshot();
      assert.ok(snapshot.errors.recent.length <= 10); // getSnapshot returns last 10
    });
  });

  describe('ECG Quality tracking', () => {
    it('should track ECG packets', () => {
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 0, sampleCount: 21,
      });
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 1, sampleCount: 21,
      });

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.ecgQuality.totalPackets, 2);
      assert.equal(snapshot.ecgQuality.droppedPackets, 0);
      assert.equal(snapshot.ecgQuality.avgSamplesPerPacket, 21);
    });

    it('should detect packet loss via sequence gaps', () => {
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 0, sampleCount: 21,
      });
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 5, sampleCount: 21,
      });

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.ecgQuality.droppedPackets, 4);
      assert.ok(snapshot.ecgQuality.packetLossRate > 0);
    });

    it('should detect out-of-order packets', () => {
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 5, sampleCount: 21,
      });
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 3, sampleCount: 21,
      });

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.ecgQuality.outOfOrderPackets, 1);
    });

    it('should detect duplicate packets', () => {
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 5, sampleCount: 21,
      });
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 5, sampleCount: 21,
      });

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.ecgQuality.duplicatePackets, 1);
    });

    it('should track per-device metrics', () => {
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 0, sampleCount: 21,
      });
      metricsCollector.recordECGPacket({
        deviceId: 'dev2', channelId: '8172', sequenceNumber: 0, sampleCount: 21,
      });

      const snapshot = metricsCollector.getSnapshot();
      assert.ok(snapshot.ecgQuality.devices['dev1:8171']);
      assert.ok(snapshot.ecgQuality.devices['dev2:8172']);
      assert.equal(snapshot.ecgQuality.devices['dev1:8171'].totalPackets, 1);
    });

    it('should estimate SNR from samples', () => {
      // Sine wave + noise
      const samples = [];
      for (let i = 0; i < 100; i++) {
        samples.push(Math.sin(i * 0.1) * 1000 + (Math.random() - 0.5) * 10);
      }
      metricsCollector.recordECGPacket({
        deviceId: 'dev1', channelId: '8171', sequenceNumber: 0, sampleCount: samples.length, samples,
      });

      const snapshot = metricsCollector.getSnapshot();
      const dev = snapshot.ecgQuality.devices['dev1:8171'];
      assert.ok(dev.snrEstimateDb !== null);
      assert.ok(typeof dev.snrEstimateDb === 'number');
    });
  });

  describe('SNR estimation', () => {
    it('should return high SNR for clean signal', () => {
      const samples = Array.from({ length: 50 }, (_, i) => Math.sin(i * 0.1) * 1000);
      const snr = metricsCollector.estimateSNR(samples);
      assert.ok(snr > 15, `Expected SNR > 15 for clean signal, got ${snr}`);
    });

    it('should return lower SNR for noisy signal', () => {
      const samples = Array.from({ length: 50 }, () => (Math.random() - 0.5) * 1000);
      const snr = metricsCollector.estimateSNR(samples);
      assert.ok(snr < 20, `Expected lower SNR for noise, got ${snr}`);
    });

    it('should handle short arrays', () => {
      const snr = metricsCollector.estimateSNR([1, 2]);
      assert.equal(snr, 0);
    });
  });

  describe('System metrics', () => {
    it('should include system metrics in snapshot', () => {
      const snapshot = metricsCollector.getSnapshot();
      assert.ok(snapshot.system.memoryTotal > 0);
      assert.ok(snapshot.system.heapUsed > 0);
      assert.ok(typeof snapshot.system.cpuUsage === 'number');
      assert.ok(Array.isArray(snapshot.system.loadAverage));
      assert.equal(snapshot.system.loadAverage.length, 3);
    });
  });

  describe('History', () => {
    it('should return empty history initially', () => {
      assert.deepEqual(metricsCollector.getHistory(), []);
    });

    it('should support count parameter', () => {
      assert.deepEqual(metricsCollector.getHistory(10), []);
    });
  });

  describe('Start/Stop', () => {
    it('should start and stop without errors', () => {
      metricsCollector.start();
      metricsCollector.stop();
    });
  });

  describe('Reset', () => {
    it('should reset all metrics to zero', () => {
      metricsCollector.recordConnection('device');
      metricsCollector.recordMessage('ecg_data', 100);
      metricsCollector.recordError('test', 'err');
      metricsCollector.reset();

      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.connections.current, 0);
      assert.equal(snapshot.connections.total, 0);
      assert.equal(snapshot.messages.received, 0);
      assert.equal(snapshot.errors.total, 0);
    });
  });
});

// ─── AlertManager Tests ──────────────────────────────────────────────────────

describe('AlertManager', () => {
  let alertManager;

  beforeEach(() => {
    alertManager = require('../src/services/alertManager');
    alertManager.reset();
  });

  describe('Alert evaluation', () => {
    it('should trigger HIGH_CONNECTIONS alert when threshold exceeded', () => {
      alertManager.evaluate({
        connections: { current: 200, peak: 200, total: 200, rejected: 0, byRole: {} },
        messages: { received: 0, processed: 0, errors: 0 },
        latency: { min: 0, max: 0, avg: 0, p95: 0, p99: 0 },
        errors: { total: 0, byCategory: {} },
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'HIGH_CONNECTIONS'));
    });

    it('should resolve alerts when condition clears', () => {
      // Trigger
      alertManager.evaluate({
        connections: { current: 200 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });
      assert.ok(alertManager.getActiveAlerts().length > 0);

      // Resolve
      alertManager.evaluate({
        connections: { current: 5 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });
      assert.ok(!alertManager.getActiveAlerts().some(a => a.ruleId === 'HIGH_CONNECTIONS'));
    });

    it('should trigger MONGODB_DISCONNECTED alert', () => {
      alertManager.evaluate(
        {
          connections: { current: 0 },
          messages: {},
          latency: {},
          errors: {},
          ecgQuality: { packetLossRate: 0, devices: {} },
          system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
        },
        { mongoState: 0 }
      );

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'MONGODB_DISCONNECTED'));
    });

    it('should trigger HIGH_EVENT_LOOP_LAG alert', () => {
      alertManager.evaluate({
        connections: { current: 0 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 1000 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'HIGH_EVENT_LOOP_LAG'));
    });

    it('should trigger HIGH_MEMORY alert', () => {
      alertManager.evaluate({
        connections: { current: 0 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 95, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'HIGH_MEMORY'));
    });

    it('should trigger HIGH_ECG_PACKET_LOSS alert', () => {
      alertManager.evaluate({
        connections: { current: 0 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 10, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'HIGH_ECG_PACKET_LOSS'));
    });

    it('should trigger LOW_ECG_SNR alert for devices', () => {
      alertManager.evaluate({
        connections: { current: 0 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: {
          packetLossRate: 0,
          devices: {
            'dev1:8171': { snrEstimateDb: 3, deviceId: 'dev1', channelId: '8171' },
          },
        },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'LOW_ECG_SNR_dev1:8171'));
    });
  });

  describe('Error and auth failure rate counting', () => {
    it('should count errors for rate-based alerts', () => {
      for (let i = 0; i < 60; i++) {
        alertManager.recordError();
      }
      alertManager.evaluate({
        connections: { current: 0 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'HIGH_ERROR_RATE'));
    });

    it('should count auth failures for rate-based alerts', () => {
      for (let i = 0; i < 15; i++) {
        alertManager.recordAuthFailure();
      }
      alertManager.evaluate({
        connections: { current: 0 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const active = alertManager.getActiveAlerts();
      assert.ok(active.some(a => a.ruleId === 'AUTH_FAILURE_SPIKE'));
    });
  });

  describe('Alert history', () => {
    it('should return alert history', () => {
      alertManager.evaluate({
        connections: { current: 200 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });

      const history = alertManager.getAlertHistory();
      assert.ok(history.length > 0);
      assert.ok(history[0].timestamp);
      assert.ok(history[0].ruleId);
      assert.ok(history[0].level);
    });
  });

  describe('Thresholds', () => {
    it('should return configured thresholds', () => {
      const thresholds = alertManager.getThresholds();
      assert.ok(thresholds.maxConnections > 0);
      assert.ok(thresholds.errorRatePerMinute > 0);
      assert.ok(thresholds.memoryUsagePercent > 0);
      assert.ok(thresholds.ecgPacketLossPercent > 0);
    });
  });

  describe('Reset', () => {
    it('should clear all alert state', () => {
      alertManager.evaluate({
        connections: { current: 200 },
        messages: {},
        latency: {},
        errors: {},
        ecgQuality: { packetLossRate: 0, devices: {} },
        system: { cpuUsage: 10, memoryUsage: 30, heapUsed: 1000, heapTotal: 10000, eventLoopLag: 5 },
      });
      assert.ok(alertManager.getActiveAlerts().length > 0);

      alertManager.reset();
      assert.equal(alertManager.getActiveAlerts().length, 0);
      assert.equal(alertManager.getAlertHistory().length, 0);
    });
  });
});

// ─── Monitoring Routes Tests ─────────────────────────────────────────────────

describe('MonitoringRoutes', () => {
  let monitoringRoutes;

  beforeEach(() => {
    monitoringRoutes = require('../src/routes/monitoringRoutes');
  });

  // Helper to create mock request/response
  function createMockReqRes(method, url) {
    const req = { method, url, headers: {} };
    let statusCode;
    let headers = {};
    let body = '';
    const res = {
      writeHead: (code, h) => { statusCode = code; headers = h || {}; },
      end: (data) => { body = data || ''; },
      getStatusCode: () => statusCode,
      getHeaders: () => headers,
      getBody: () => body,
      getParsedBody: () => { try { return JSON.parse(body); } catch { return null; } },
    };
    return { req, res };
  }

  describe('GET /health', () => {
    it('should return health status', () => {
      const { req, res } = createMockReqRes('GET', '/health');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getParsedBody();
      assert.ok(body);
      assert.ok(['healthy', 'degraded'].includes(body.status));
      assert.ok(body.timestamp);
      assert.ok(typeof body.uptime === 'number');
    });
  });

  describe('GET /health/detailed', () => {
    it('should return detailed health with all sections', () => {
      const { req, res } = createMockReqRes('GET', '/health/detailed');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getParsedBody();
      assert.ok(body);
      assert.ok(body.status);
      assert.ok(body.components);
      assert.ok(body.components.mongodb);
      assert.ok(body.components.websocket);
      assert.ok(body.components.ecgPipeline);
      assert.ok(body.metrics);
      assert.ok(body.alerts);
      assert.ok(body.sessions);
      assert.ok(body.server);
    });
  });

  describe('GET /api/v1/monitoring/metrics', () => {
    it('should return metrics snapshot', () => {
      const { req, res } = createMockReqRes('GET', '/api/v1/monitoring/metrics');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getParsedBody();
      assert.ok(body.data);
      assert.ok(body.data.connections);
      assert.ok(body.data.messages);
      assert.ok(body.data.system);
    });
  });

  describe('GET /api/v1/monitoring/history', () => {
    it('should return metrics history', () => {
      const { req, res } = createMockReqRes('GET', '/api/v1/monitoring/history?count=10');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getParsedBody();
      assert.ok(Array.isArray(body.data));
      assert.ok(typeof body.count === 'number');
    });
  });

  describe('GET /api/v1/monitoring/alerts', () => {
    it('should return alerts data', () => {
      const { req, res } = createMockReqRes('GET', '/api/v1/monitoring/alerts');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getParsedBody();
      assert.ok(Array.isArray(body.active));
      assert.ok(Array.isArray(body.history));
      assert.ok(body.thresholds);
    });
  });

  describe('GET /api/v1/monitoring/ecg-quality', () => {
    it('should return ECG quality data', () => {
      const { req, res } = createMockReqRes('GET', '/api/v1/monitoring/ecg-quality');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getParsedBody();
      assert.ok(body.data);
      assert.ok(body.data.summary);
      assert.ok(typeof body.data.summary.totalPackets === 'number');
      assert.ok(typeof body.data.summary.packetLossRate === 'number');
    });
  });

  describe('GET /monitoring', () => {
    it('should return HTML dashboard', () => {
      const { req, res } = createMockReqRes('GET', '/monitoring');
      const handled = monitoringRoutes.handleRequest(req, res);

      assert.equal(handled, true);
      const body = res.getBody();
      assert.ok(body.includes('<!DOCTYPE html>'));
      assert.ok(body.includes('Horizon Medical'));
      assert.ok(body.includes('Monitoring Dashboard'));
    });
  });

  describe('Unhandled routes', () => {
    it('should return false for unknown paths', () => {
      const { req, res } = createMockReqRes('GET', '/unknown');
      const handled = monitoringRoutes.handleRequest(req, res);
      assert.equal(handled, false);
    });

    it('should return false for non-GET methods', () => {
      const { req, res } = createMockReqRes('POST', '/health');
      const handled = monitoringRoutes.handleRequest(req, res);
      assert.equal(handled, false);
    });
  });
});
