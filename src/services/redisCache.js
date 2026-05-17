/**
 * @module redisCache
 * @description Redis-based caching layer for Horizon Medical WSS.
 *
 * Provides:
 *   - Session caching (active ECG sessions)
 *   - Device status caching (battery, connectivity, last activity)
 *   - Query result caching (sessions list, stats)
 *   - Graceful fallback when Redis is unavailable
 *
 * Architecture:
 *   Uses ioredis with automatic reconnection. All cache operations are
 *   wrapped in try/catch so the server continues working even if Redis
 *   is down (cache-aside pattern with graceful degradation).
 */

'use strict';

const Redis = require('ioredis');
const logger = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'hrzmed:';
const REDIS_ENABLED = process.env.REDIS_ENABLED !== 'false';

// TTL defaults (seconds)
const TTL = {
  SESSION: parseInt(process.env.REDIS_TTL_SESSION, 10) || 300,       // 5 min
  DEVICE_STATUS: parseInt(process.env.REDIS_TTL_DEVICE, 10) || 60,   // 1 min
  QUERY_RESULT: parseInt(process.env.REDIS_TTL_QUERY, 10) || 30,     // 30s
  STATS: parseInt(process.env.REDIS_TTL_STATS, 10) || 15,            // 15s
  ACTIVE_SESSIONS: parseInt(process.env.REDIS_TTL_ACTIVE, 10) || 10, // 10s
};

// ─── Redis Client ────────────────────────────────────────────────────────────

let client = null;
let isConnected = false;

/**
 * Initialize Redis connection.
 * @returns {Object|null} Redis client or null if disabled
 */
function init() {
  if (!REDIS_ENABLED) {
    logger.info('Redis cache DISABLED');
    return null;
  }

  try {
    client = new Redis(REDIS_URL, {
      keyPrefix: REDIS_KEY_PREFIX,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) {
          logger.warn('Redis: max reconnection attempts reached, backing off');
          return Math.min(times * 1000, 30000);
        }
        return Math.min(times * 200, 5000);
      },
      reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
      lazyConnect: false,
      enableReadyCheck: true,
      connectTimeout: 5000,
    });

    client.on('connect', () => {
      isConnected = true;
      logger.info('Redis connected', { url: REDIS_URL.replace(/\/\/:[^@]+@/, '//***@') });
    });

    client.on('ready', () => {
      isConnected = true;
      logger.info('Redis ready');
    });

    client.on('error', (err) => {
      isConnected = false;
      logger.warn('Redis error (degraded mode)', { error: err.message });
    });

    client.on('close', () => {
      isConnected = false;
      logger.warn('Redis connection closed');
    });

    client.on('reconnecting', (ms) => {
      logger.info('Redis reconnecting', { delayMs: ms });
    });

    return client;
  } catch (err) {
    logger.warn('Redis initialization failed (running without cache)', { error: err.message });
    return null;
  }
}

// ─── Cache Helpers ───────────────────────────────────────────────────────────

/**
 * Safe cache get — returns null on any failure.
 */
async function get(key) {
  if (!isConnected || !client) return null;
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.debug('Redis GET failed', { key, error: err.message });
    return null;
  }
}

/**
 * Safe cache set with TTL.
 */
async function set(key, value, ttlSeconds) {
  if (!isConnected || !client) return false;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch (err) {
    logger.debug('Redis SET failed', { key, error: err.message });
    return false;
  }
}

/**
 * Safe cache delete.
 */
async function del(key) {
  if (!isConnected || !client) return false;
  try {
    await client.del(key);
    return true;
  } catch (err) {
    logger.debug('Redis DEL failed', { key, error: err.message });
    return false;
  }
}

/**
 * Delete multiple keys by pattern.
 */
async function delPattern(pattern) {
  if (!isConnected || !client) return false;
  try {
    const fullPattern = `${REDIS_KEY_PREFIX}${pattern}`;
    const stream = client.scanStream({ match: fullPattern, count: 100 });
    const pipeline = client.pipeline();
    let count = 0;

    return new Promise((resolve) => {
      stream.on('data', (keys) => {
        keys.forEach((key) => {
          // Remove prefix since pipeline uses keyPrefix
          const shortKey = key.replace(REDIS_KEY_PREFIX, '');
          pipeline.del(shortKey);
          count++;
        });
      });
      stream.on('end', async () => {
        if (count > 0) await pipeline.exec();
        resolve(true);
      });
      stream.on('error', () => resolve(false));
    });
  } catch (err) {
    logger.debug('Redis DELPATTERN failed', { pattern, error: err.message });
    return false;
  }
}

// ─── Domain-Specific Cache Operations ────────────────────────────────────────

/**
 * Cache an active ECG session.
 */
async function cacheSession(sessionId, sessionData) {
  return set(`session:${sessionId}`, sessionData, TTL.SESSION);
}

/**
 * Get cached session.
 */
async function getCachedSession(sessionId) {
  return get(`session:${sessionId}`);
}

/**
 * Invalidate a session cache entry.
 */
async function invalidateSession(sessionId) {
  return del(`session:${sessionId}`);
}

/**
 * Cache device status info.
 */
async function cacheDeviceStatus(deviceId, statusData) {
  return set(`device:${deviceId}`, statusData, TTL.DEVICE_STATUS);
}

/**
 * Get cached device status.
 */
async function getCachedDeviceStatus(deviceId) {
  return get(`device:${deviceId}`);
}

/**
 * Cache a query result (sessions list, patient data, etc).
 * @param {string} queryKey - Unique key representing the query + params
 * @param {Object} result - Query result to cache
 * @param {number} [ttl] - Optional custom TTL
 */
async function cacheQueryResult(queryKey, result, ttl) {
  return set(`query:${queryKey}`, result, ttl || TTL.QUERY_RESULT);
}

/**
 * Get cached query result.
 */
async function getCachedQueryResult(queryKey) {
  return get(`query:${queryKey}`);
}

/**
 * Cache aggregated stats.
 */
async function cacheStats(stats) {
  return set('stats:global', stats, TTL.STATS);
}

/**
 * Get cached stats.
 */
async function getCachedStats() {
  return get('stats:global');
}

/**
 * Invalidate all query caches (e.g., after new data arrives).
 */
async function invalidateQueryCaches() {
  return delPattern('query:*');
}

/**
 * Cache active sessions list.
 */
async function cacheActiveSessions(sessions) {
  return set('sessions:active', sessions, TTL.ACTIVE_SESSIONS);
}

/**
 * Get cached active sessions.
 */
async function getCachedActiveSessions() {
  return get('sessions:active');
}

// ─── Health / Stats ──────────────────────────────────────────────────────────

/**
 * Get Redis cache health info.
 */
async function getHealth() {
  if (!REDIS_ENABLED) {
    return { enabled: false, status: 'disabled' };
  }
  if (!isConnected || !client) {
    return { enabled: true, status: 'disconnected' };
  }

  try {
    const info = await client.info('memory');
    const memMatch = info.match(/used_memory_human:(\S+)/);
    const keysInfo = await client.info('keyspace');
    const dbMatch = keysInfo.match(/db0:keys=(\d+)/);

    return {
      enabled: true,
      status: 'connected',
      memoryUsed: memMatch ? memMatch[1] : 'unknown',
      totalKeys: dbMatch ? parseInt(dbMatch[1], 10) : 0,
      keyPrefix: REDIS_KEY_PREFIX,
    };
  } catch (err) {
    return { enabled: true, status: 'error', error: err.message };
  }
}

/**
 * Graceful shutdown.
 */
async function shutdown() {
  if (client) {
    try {
      await client.quit();
      logger.info('Redis connection closed');
    } catch (err) {
      logger.warn('Redis shutdown error', { error: err.message });
      client.disconnect();
    }
  }
}

module.exports = {
  init,
  get,
  set,
  del,
  delPattern,
  cacheSession,
  getCachedSession,
  invalidateSession,
  cacheDeviceStatus,
  getCachedDeviceStatus,
  cacheQueryResult,
  getCachedQueryResult,
  cacheStats,
  getCachedStats,
  invalidateQueryCaches,
  cacheActiveSessions,
  getCachedActiveSessions,
  getHealth,
  shutdown,
  TTL,
  // Expose for testing
  _isConnected: () => isConnected,
  _getClient: () => client,
};
