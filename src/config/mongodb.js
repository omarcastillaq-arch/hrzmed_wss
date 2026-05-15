/**
 * @module mongodbConfig
 * @description Optimized MongoDB connection configuration with connection pooling,
 * retry logic, and performance tuning for the Horizon Medical platform.
 *
 * Features:
 *   - Configurable connection pool size based on expected concurrency
 *   - Automatic retry with exponential backoff
 *   - Read/write concern tuning for medical data integrity
 *   - Connection monitoring and health checks
 *   - Graceful reconnection handling
 */

'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────────────

const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Build optimized MongoDB connection options.
 * Pool size scales with expected concurrent devices.
 */
function getConnectionOptions() {
  const isProduction = NODE_ENV === 'production';

  return {
    // ── Connection Pool ────────────────────────────────────────────────────
    // Default pool is 5 in mongoose, we scale up for concurrent device writes
    maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE, 10) || (isProduction ? 50 : 20),
    minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || (isProduction ? 10 : 2),

    // ── Timeouts ───────────────────────────────────────────────────────────
    connectTimeoutMS: parseInt(process.env.MONGO_CONNECT_TIMEOUT, 10) || 10000,
    socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT, 10) || 45000,
    serverSelectionTimeoutMS: parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT, 10) || 15000,

    // ── Write Concern ──────────────────────────────────────────────────────
    // Medical data: acknowledge writes to at least one node
    writeConcern: {
      w: isProduction ? 'majority' : 1,
      wtimeout: 5000,
    },

    // ── Read Preference ────────────────────────────────────────────────────
    // For replica sets: read from secondaries for queries, primary for writes
    readPreference: isProduction ? 'secondaryPreferred' : 'primary',

    // ── Compression ────────────────────────────────────────────────────────
    // Compress data between app and MongoDB (reduces bandwidth)
    compressors: ['zstd', 'snappy', 'zlib'],

    // ── Retry Logic ────────────────────────────────────────────────────────
    retryWrites: true,
    retryReads: true,

    // ── Heartbeat ──────────────────────────────────────────────────────────
    heartbeatFrequencyMS: isProduction ? 10000 : 30000,

    // ── Max idle time for pool connections ──────────────────────────────────
    maxIdleTimeMS: 60000,

    // ── Auto index (disable in production for performance) ─────────────────
    autoIndex: !isProduction,
  };
}

// ─── Connection State ────────────────────────────────────────────────────────

let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 10;
const BASE_RETRY_DELAY = 1000;

/**
 * Connect to MongoDB with optimized settings and retry logic.
 * @param {string} uri - MongoDB connection URI
 * @returns {Promise<mongoose.Connection>}
 */
async function connect(uri) {
  const options = getConnectionOptions();

  // Configure mongoose global settings
  mongoose.set('bufferCommands', false); // Fail fast if not connected
  mongoose.set('bufferTimeoutMS', 10000);

  logger.info('MongoDB connecting with optimized pool', {
    maxPoolSize: options.maxPoolSize,
    minPoolSize: options.minPoolSize,
    writeConcern: options.writeConcern.w,
    readPreference: options.readPreference,
    compressors: options.compressors,
    retryWrites: options.retryWrites,
  });

  return connectWithRetry(uri, options);
}

/**
 * Connect with exponential backoff retry.
 */
async function connectWithRetry(uri, options) {
  while (connectionAttempts < MAX_RETRY_ATTEMPTS) {
    try {
      await mongoose.connect(uri, options);
      connectionAttempts = 0;
      setupConnectionMonitoring();
      logger.info('MongoDB connected successfully', {
        uri: uri.replace(/\/\/[^@]+@/, '//***:***@'),
        poolSize: options.maxPoolSize,
      });
      return mongoose.connection;
    } catch (err) {
      connectionAttempts++;
      const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, connectionAttempts), 30000);
      logger.warn(`MongoDB connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS} failed`, {
        error: err.message,
        retryInMs: delay,
      });

      if (connectionAttempts >= MAX_RETRY_ATTEMPTS) {
        logger.error('MongoDB max retry attempts reached, exiting');
        throw err;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Set up connection event monitoring.
 */
function setupConnectionMonitoring() {
  const conn = mongoose.connection;

  conn.on('error', (err) => {
    logger.error('MongoDB runtime error', { error: err.message });
  });

  conn.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  conn.on('reconnected', () => {
    logger.info('MongoDB reconnected');
    connectionAttempts = 0;
  });

  // Monitor pool events (when using MongoDB driver directly)
  if (conn.getClient && conn.getClient()) {
    const topology = conn.getClient().topology;
    if (topology) {
      topology.on('connectionPoolCreated', (event) => {
        logger.debug('MongoDB pool created', { address: event.address });
      });
      topology.on('connectionPoolCleared', (event) => {
        logger.debug('MongoDB pool cleared', { address: event.address });
      });
    }
  }
}

/**
 * Get connection pool statistics.
 * @returns {Object} Pool stats
 */
function getPoolStats() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) {
    return { status: 'disconnected', readyState: conn?.readyState || 0 };
  }

  const options = getConnectionOptions();

  return {
    status: 'connected',
    readyState: conn.readyState,
    host: conn.host,
    port: conn.port,
    name: conn.name,
    maxPoolSize: options.maxPoolSize,
    minPoolSize: options.minPoolSize,
    writeConcern: options.writeConcern.w,
    readPreference: options.readPreference,
  };
}

/**
 * Ensure all indexes are created (run at startup in production).
 * This is separate from autoIndex to give us control over timing.
 */
async function ensureIndexes() {
  try {
    const models = mongoose.modelNames();
    for (const modelName of models) {
      const model = mongoose.model(modelName);
      await model.ensureIndexes();
      logger.info(`Indexes ensured for ${modelName}`);
    }
    logger.info('All MongoDB indexes ensured', { models });
  } catch (err) {
    logger.error('Failed to ensure indexes', { error: err.message });
  }
}

/**
 * Graceful shutdown — close connection pool.
 */
async function shutdown() {
  try {
    await mongoose.connection.close(false);
    logger.info('MongoDB connection pool closed gracefully');
  } catch (err) {
    logger.error('MongoDB shutdown error', { error: err.message });
    throw err;
  }
}

module.exports = {
  connect,
  getConnectionOptions,
  getPoolStats,
  ensureIndexes,
  shutdown,
};
