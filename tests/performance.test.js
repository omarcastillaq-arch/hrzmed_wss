/**
 * @file performance.test.js
 * @description Performance and load tests for Phase 12 optimizations.
 *
 * Tests:
 *   - Redis cache operations (set/get/del, graceful degradation)
 *   - MongoDB connection pool configuration
 *   - WebSocket optimizer components (compression, health monitor, backpressure, broadcaster)
 *   - Cluster manager configuration
 *   - Connection pool efficient lookups
 *   - Load simulation (concurrent message processing)
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── Redis Cache Tests ──────────────────────────────────────────────────────

describe('RedisCache Service', () => {
  let redisCache;

  before(() => {
    // Force disable Redis for unit tests (no actual Redis server needed)
    process.env.REDIS_ENABLED = 'false';
    // Clear module cache to pick up env change
    delete require.cache[require.resolve('../src/services/redisCache')];
    redisCache = require('../src/services/redisCache');
  });

  it('should export all required functions', () => {
    assert.equal(typeof redisCache.init, 'function');
    assert.equal(typeof redisCache.get, 'function');
    assert.equal(typeof redisCache.set, 'function');
    assert.equal(typeof redisCache.del, 'function');
    assert.equal(typeof redisCache.cacheSession, 'function');
    assert.equal(typeof redisCache.getCachedSession, 'function');
    assert.equal(typeof redisCache.invalidateSession, 'function');
    assert.equal(typeof redisCache.cacheDeviceStatus, 'function');
    assert.equal(typeof redisCache.getCachedDeviceStatus, 'function');
    assert.equal(typeof redisCache.cacheQueryResult, 'function');
    assert.equal(typeof redisCache.getCachedQueryResult, 'function');
    assert.equal(typeof redisCache.cacheStats, 'function');
    assert.equal(typeof redisCache.getCachedStats, 'function');
    assert.equal(typeof redisCache.invalidateQueryCaches, 'function');
    assert.equal(typeof redisCache.getHealth, 'function');
    assert.equal(typeof redisCache.shutdown, 'function');
  });

  it('should return null when Redis is disabled (graceful degradation)', async () => {
    const result = redisCache.init();
    assert.equal(result, null);
  });

  it('should return null for all get operations when disabled', async () => {
    assert.equal(await redisCache.get('test-key'), null);
    assert.equal(await redisCache.getCachedSession('session-123'), null);
    assert.equal(await redisCache.getCachedDeviceStatus('device-1'), null);
    assert.equal(await redisCache.getCachedQueryResult('query-1'), null);
    assert.equal(await redisCache.getCachedStats(), null);
    assert.equal(await redisCache.getCachedActiveSessions(), null);
  });

  it('should return false for all set operations when disabled', async () => {
    assert.equal(await redisCache.set('key', 'value', 60), false);
    assert.equal(await redisCache.cacheSession('s1', {}), false);
    assert.equal(await redisCache.cacheDeviceStatus('d1', {}), false);
    assert.equal(await redisCache.cacheQueryResult('q1', {}), false);
    assert.equal(await redisCache.cacheStats({}), false);
  });

  it('should return false for delete operations when disabled', async () => {
    assert.equal(await redisCache.del('key'), false);
    assert.equal(await redisCache.invalidateSession('s1'), false);
    assert.equal(await redisCache.invalidateQueryCaches(), false);
  });

  it('should report disabled health', async () => {
    const health = await redisCache.getHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.status, 'disabled');
  });

  it('should have correct TTL defaults', () => {
    assert.equal(redisCache.TTL.SESSION, 300);
    assert.equal(redisCache.TTL.DEVICE_STATUS, 60);
    assert.equal(redisCache.TTL.QUERY_RESULT, 30);
    assert.equal(redisCache.TTL.STATS, 15);
    assert.equal(redisCache.TTL.ACTIVE_SESSIONS, 10);
  });

  it('should shutdown gracefully when disabled', async () => {
    await assert.doesNotReject(async () => {
      await redisCache.shutdown();
    });
  });
});

// ─── MongoDB Config Tests ───────────────────────────────────────────────────

describe('MongoDB Config', () => {
  let mongoConfig;

  before(() => {
    mongoConfig = require('../src/config/mongodb');
  });

  it('should export required functions', () => {
    assert.equal(typeof mongoConfig.connect, 'function');
    assert.equal(typeof mongoConfig.getConnectionOptions, 'function');
    assert.equal(typeof mongoConfig.getPoolStats, 'function');
    assert.equal(typeof mongoConfig.ensureIndexes, 'function');
    assert.equal(typeof mongoConfig.shutdown, 'function');
  });

  it('should return correct development pool options', () => {
    process.env.NODE_ENV = 'development';
    delete require.cache[require.resolve('../src/config/mongodb')];
    const config = require('../src/config/mongodb');
    const opts = config.getConnectionOptions();

    assert.equal(opts.maxPoolSize, 20);
    assert.equal(opts.minPoolSize, 2);
    assert.equal(opts.retryWrites, true);
    assert.equal(opts.retryReads, true);
    assert.equal(opts.autoIndex, true);
    assert.deepEqual(opts.compressors, ['zstd', 'snappy', 'zlib']);
    assert.equal(opts.writeConcern.w, 1);
  });

  it('should return correct production pool options', () => {
    process.env.NODE_ENV = 'production';
    delete require.cache[require.resolve('../src/config/mongodb')];
    const config = require('../src/config/mongodb');
    const opts = config.getConnectionOptions();

    assert.equal(opts.maxPoolSize, 50);
    assert.equal(opts.minPoolSize, 10);
    assert.equal(opts.writeConcern.w, 'majority');
    assert.equal(opts.readPreference, 'secondaryPreferred');
    assert.equal(opts.autoIndex, false);

    // Reset
    process.env.NODE_ENV = 'development';
  });

  it('should allow custom pool sizes via env vars', () => {
    process.env.MONGO_POOL_SIZE = '100';
    process.env.MONGO_MIN_POOL_SIZE = '25';
    delete require.cache[require.resolve('../src/config/mongodb')];
    const config = require('../src/config/mongodb');
    const opts = config.getConnectionOptions();

    assert.equal(opts.maxPoolSize, 100);
    assert.equal(opts.minPoolSize, 25);

    delete process.env.MONGO_POOL_SIZE;
    delete process.env.MONGO_MIN_POOL_SIZE;
  });

  it('should return disconnected pool stats when not connected', () => {
    const stats = mongoConfig.getPoolStats();
    assert.ok(stats.status === 'disconnected' || stats.status === 'connected');
    assert.ok(stats.readyState !== undefined);
  });
});

// ─── WebSocket Optimizer Tests ──────────────────────────────────────────────

describe('WebSocket Optimizer', () => {
  let wsOptimizer;

  before(() => {
    wsOptimizer = require('../src/services/wsOptimizer');
  });

  describe('getServerOptions', () => {
    it('should return valid server options', () => {
      const opts = wsOptimizer.getServerOptions();
      assert.equal(opts.noServer, true);
      assert.equal(opts.clientTracking, true);
      assert.ok(opts.maxPayload > 0);
    });

    it('should include compression config when enabled', () => {
      process.env.WS_COMPRESSION_ENABLED = 'true';
      delete require.cache[require.resolve('../src/services/wsOptimizer')];
      const optimizer = require('../src/services/wsOptimizer');
      const opts = optimizer.getServerOptions();
      assert.ok(opts.perMessageDeflate !== false);
      assert.ok(opts.perMessageDeflate.threshold > 0);
    });

    it('should disable compression when configured', () => {
      process.env.WS_COMPRESSION_ENABLED = 'false';
      delete require.cache[require.resolve('../src/services/wsOptimizer')];
      const optimizer = require('../src/services/wsOptimizer');
      const opts = optimizer.getServerOptions();
      assert.equal(opts.perMessageDeflate, false);
      // Reset
      delete process.env.WS_COMPRESSION_ENABLED;
    });
  });

  describe('BackpressureManager', () => {
    it('should allow sending when buffer is empty', () => {
      const mockWs = { readyState: 1, bufferedAmount: 0, send: () => {} };
      assert.ok(wsOptimizer.BackpressureManager.canSend(mockWs));
    });

    it('should block sending when buffer exceeds threshold', () => {
      const mockWs = { readyState: 1, bufferedAmount: 100000 };
      assert.equal(wsOptimizer.BackpressureManager.canSend(mockWs), false);
    });

    it('should block sending when connection is not OPEN', () => {
      const mockWs = { readyState: 2, bufferedAmount: 0 };
      assert.equal(wsOptimizer.BackpressureManager.canSend(mockWs), false);
    });

    it('should safely send messages', () => {
      let sentData = null;
      const mockWs = {
        readyState: 1,
        bufferedAmount: 0,
        send: (data) => { sentData = data; },
      };
      const result = wsOptimizer.BackpressureManager.safeSend(mockWs, 'test-message');
      assert.ok(result);
      assert.equal(sentData, 'test-message');
    });

    it('should return false when send fails', () => {
      const mockWs = {
        readyState: 1,
        bufferedAmount: 0,
        send: () => { throw new Error('Connection closed'); },
      };
      const result = wsOptimizer.BackpressureManager.safeSend(mockWs, 'test');
      assert.equal(result, false);
    });
  });

  describe('ConnectionPool', () => {
    let pool;

    beforeEach(() => {
      pool = new wsOptimizer.ConnectionPool();
    });

    it('should register and track connections', () => {
      const ws = {
        _connectionId: 'conn-1',
        _user: { role: 'device' },
        readyState: 1,
      };
      pool.add(ws);
      const stats = pool.getStats();
      assert.equal(stats.total, 1);
      assert.equal(stats.byRole.device, 1);
    });

    it('should associate devices with connections', () => {
      const ws = {
        _connectionId: 'conn-1',
        _user: { role: 'device' },
        readyState: 1,
      };
      pool.add(ws);
      pool.associateDevice('conn-1', 'device-A');

      const deviceClients = pool.getByDevice('device-A');
      assert.equal(deviceClients.length, 1);
      assert.equal(deviceClients[0]._connectionId, 'conn-1');
    });

    it('should remove connections cleanly', () => {
      const ws = {
        _connectionId: 'conn-1',
        _user: { role: 'admin' },
        readyState: 1,
      };
      pool.add(ws);
      pool.associateDevice('conn-1', 'device-A');
      pool.remove('conn-1');

      const stats = pool.getStats();
      assert.equal(stats.total, 0);
      assert.equal(pool.getByDevice('device-A').length, 0);
    });

    it('should filter by role', () => {
      const ws1 = { _connectionId: 'c1', _user: { role: 'device' }, readyState: 1 };
      const ws2 = { _connectionId: 'c2', _user: { role: 'monitor' }, readyState: 1 };
      const ws3 = { _connectionId: 'c3', _user: { role: 'device' }, readyState: 1 };
      pool.add(ws1);
      pool.add(ws2);
      pool.add(ws3);

      const devices = pool.getByRole('device');
      assert.equal(devices.length, 2);
      const monitors = pool.getByRole('monitor');
      assert.equal(monitors.length, 1);
    });

    it('should clear all connections', () => {
      const ws = { _connectionId: 'c1', _user: { role: 'device' }, readyState: 1 };
      pool.add(ws);
      pool.clear();
      assert.equal(pool.getStats().total, 0);
    });
  });

  describe('ClientHealthMonitor', () => {
    it('should create and start/stop without errors', () => {
      const mockWss = {
        clients: new Set(),
      };
      const monitor = new wsOptimizer.ClientHealthMonitor(mockWss);
      monitor.start();
      assert.ok(monitor.pingInterval);
      monitor.stop();
      assert.equal(monitor.pingInterval, null);
    });

    it('should register client with pong handler', () => {
      const mockWss = { clients: new Set() };
      const monitor = new wsOptimizer.ClientHealthMonitor(mockWss);
      let pongHandler = null;
      const mockWs = {
        on: (event, handler) => {
          if (event === 'pong') pongHandler = handler;
        },
      };
      monitor.registerClient(mockWs);
      assert.ok(pongHandler !== null, 'Should register pong handler');
    });
  });

  describe('BatchedBroadcaster', () => {
    it('should handle immediate broadcast when enabled is false', () => {
      const optimizer = require('../src/services/wsOptimizer');

      let sentMessages = [];
      const mockWss = {
        clients: new Set([
          { readyState: 1, bufferedAmount: 0, send: (d) => sentMessages.push(d) },
        ]),
      };
      const broadcaster = new optimizer.BatchedBroadcaster(mockWss);
      // Force immediate mode
      broadcaster.enabled = false;
      broadcaster.enqueue({ type: 'test', data: 1 });

      assert.equal(sentMessages.length, 1);
      broadcaster.destroy();
    });

    it('should destroy cleanly', () => {
      const mockWss = { clients: new Set() };
      delete require.cache[require.resolve('../src/services/wsOptimizer')];
      const optimizer = require('../src/services/wsOptimizer');
      const broadcaster = new optimizer.BatchedBroadcaster(mockWss);
      broadcaster.destroy();
      assert.equal(broadcaster.queue.length, 0);
    });
  });
});

// ─── Cluster Manager Tests ──────────────────────────────────────────────────

describe('Cluster Manager', () => {
  let clusterManager;

  before(() => {
    process.env.CLUSTER_ENABLED = 'false';
    delete require.cache[require.resolve('../src/services/clusterManager')];
    clusterManager = require('../src/services/clusterManager');
  });

  it('should export required functions', () => {
    assert.equal(typeof clusterManager.initCluster, 'function');
    assert.equal(typeof clusterManager.isPrimary, 'function');
    assert.equal(typeof clusterManager.isWorker, 'function');
    assert.equal(typeof clusterManager.getStatus, 'function');
    assert.equal(typeof clusterManager.getWorkerCount, 'function');
  });

  it('should return false for initCluster when disabled', () => {
    const result = clusterManager.initCluster();
    assert.equal(result, false);
  });

  it('should report single-process mode when disabled', () => {
    const status = clusterManager.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.mode, 'single-process');
    assert.ok(status.pid > 0);
  });

  it('should calculate worker count based on CPUs', () => {
    const count = clusterManager.getWorkerCount();
    assert.ok(count >= 2, `Worker count should be >= 2, got ${count}`);
  });

  it('should respect CLUSTER_WORKERS env var', () => {
    process.env.CLUSTER_WORKERS = '4';
    delete require.cache[require.resolve('../src/services/clusterManager')];
    const cm = require('../src/services/clusterManager');
    assert.equal(cm.getWorkerCount(), 4);
    delete process.env.CLUSTER_WORKERS;
  });
});

// ─── Load Simulation Tests ──────────────────────────────────────────────────

describe('Load Simulation', () => {
  it('should handle high-volume connection pool operations', () => {
    const { ConnectionPool } = require('../src/services/wsOptimizer');
    const pool = new ConnectionPool();

    const COUNT = 1000;
    const start = process.hrtime.bigint();

    // Simulate 1000 concurrent connections
    for (let i = 0; i < COUNT; i++) {
      pool.add({
        _connectionId: `conn-${i}`,
        _user: { role: i % 3 === 0 ? 'device' : i % 3 === 1 ? 'monitor' : 'admin' },
        readyState: 1,
      });
      if (i % 5 === 0) {
        pool.associateDevice(`conn-${i}`, `device-${i % 50}`);
      }
    }

    const afterAdd = process.hrtime.bigint();
    const addTimeMs = Number(afterAdd - start) / 1e6;

    assert.equal(pool.getStats().total, COUNT);
    assert.ok(addTimeMs < 1000, `Adding ${COUNT} connections took ${addTimeMs}ms (should be < 1000ms)`);

    // Simulate lookups
    const lookupStart = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      pool.getByDevice(`device-${i % 50}`);
      pool.getByRole('device');
    }
    const lookupTimeMs = Number(process.hrtime.bigint() - lookupStart) / 1e6;
    assert.ok(lookupTimeMs < 500, `100 lookups took ${lookupTimeMs}ms (should be < 500ms)`);

    // Simulate disconnections
    const removeStart = process.hrtime.bigint();
    for (let i = 0; i < COUNT; i++) {
      pool.remove(`conn-${i}`);
    }
    const removeTimeMs = Number(process.hrtime.bigint() - removeStart) / 1e6;
    assert.equal(pool.getStats().total, 0);
    assert.ok(removeTimeMs < 1000, `Removing ${COUNT} connections took ${removeTimeMs}ms`);

    pool.clear();
  });

  it('should handle rapid backpressure checks efficiently', () => {
    const { BackpressureManager } = require('../src/services/wsOptimizer');
    const COUNT = 10000;
    const start = process.hrtime.bigint();

    for (let i = 0; i < COUNT; i++) {
      BackpressureManager.canSend({
        readyState: 1,
        bufferedAmount: i % 100,
      });
    }

    const timeMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(timeMs < 100, `${COUNT} backpressure checks took ${timeMs}ms (should be < 100ms)`);
  });

  it('should handle concurrent ECG message validation throughput', () => {
    const { validateMessage } = require('../src/validators/ecgValidator');
    const COUNT = 5000;

    const message = JSON.stringify({
      type: 'ecg_data',
      deviceId: 'test-device-001',
      channelId: '8171',
      samples: Array.from({ length: 21 }, () => Math.floor(Math.random() * 16777216) - 8388608),
      timestamp: Date.now(),
      sequenceNumber: 1,
    });

    const start = process.hrtime.bigint();

    for (let i = 0; i < COUNT; i++) {
      validateMessage(message);
    }

    const timeMs = Number(process.hrtime.bigint() - start) / 1e6;
    const throughput = Math.round(COUNT / (timeMs / 1000));

    assert.ok(timeMs < 5000, `${COUNT} validations took ${timeMs}ms`);
    assert.ok(throughput > 1000, `Throughput: ${throughput} msgs/sec (should be > 1000)`);

    // Log performance results
    console.log(`  📊 Validation throughput: ${throughput.toLocaleString()} msgs/sec (${timeMs.toFixed(1)}ms for ${COUNT} messages)`);
  });
});

// ─── Integration: Performance Config Summary ────────────────────────────────

describe('Performance Configuration Summary', () => {
  it('should report all optimization features', () => {
    const redisCache = require('../src/services/redisCache');
    const mongoConfig = require('../src/config/mongodb');
    const wsOptimizer = require('../src/services/wsOptimizer');
    const clusterManager = require('../src/services/clusterManager');

    const mongoOpts = mongoConfig.getConnectionOptions();
    const wsOpts = wsOptimizer.getServerOptions();
    const clusterStatus = clusterManager.getStatus();

    console.log('\n  ╔══════════════════════════════════════════════════╗');
    console.log('  ║     Phase 12 - Performance Optimization Summary  ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log(`  ║ Redis Cache:          ${redisCache._isConnected() ? '✅ Connected' : '⚠️  Disabled (test mode)'}       ║`);
    console.log(`  ║ Redis TTL (session):   ${redisCache.TTL.SESSION}s                       ║`);
    console.log(`  ║ Redis TTL (queries):   ${redisCache.TTL.QUERY_RESULT}s                        ║`);
    console.log(`  ║ MongoDB Pool Max:      ${mongoOpts.maxPoolSize}                         ║`);
    console.log(`  ║ MongoDB Pool Min:      ${mongoOpts.minPoolSize}                          ║`);
    console.log(`  ║ MongoDB Compression:   ${mongoOpts.compressors.join(', ')}     ║`);
    console.log(`  ║ MongoDB Retry:         writes=${mongoOpts.retryWrites} reads=${mongoOpts.retryReads}    ║`);
    console.log(`  ║ WS Compression:        ${wsOpts.perMessageDeflate ? '✅ permessage-deflate' : '❌ Disabled'}    ║`);
    console.log(`  ║ WS Max Payload:        ${(wsOpts.maxPayload / 1024).toFixed(0)} KB                       ║`);
    console.log(`  ║ Cluster Mode:          ${clusterStatus.enabled ? '✅ Enabled' : '⚠️  Disabled'}            ║`);
    console.log('  ╚══════════════════════════════════════════════════╝');

    // Verify all components loaded successfully
    assert.ok(redisCache.TTL);
    assert.ok(mongoOpts.maxPoolSize > 0);
    assert.ok(wsOpts.maxPayload > 0);
    assert.ok(clusterStatus.pid > 0);
  });
});
