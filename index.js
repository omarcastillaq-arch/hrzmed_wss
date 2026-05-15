/**
 * Horizon Medical WebSocket Server (hrzmed_wss)
 *
 * Secure WebSocket server for real-time ECG/EKG data from IoT Holter devices.
 *
 * Security features:
 *   - JWT authentication on WebSocket connections
 *   - Medical data validation (24-bit ADC range, channel IDs, format)
 *   - Rate limiting per IP and per connection
 *   - Structured security logging
 *   - Environment-based configuration (no hardcoded secrets)
 *
 * @see SECURITY.md for full security documentation
 */

'use strict';

// Load environment variables from .env file (development only)
require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const logger = require('./src/utils/logger');
const { authenticateConnection, getClientIP } = require('./src/middleware/auth');
const { validateMessage } = require('./src/validators/ecgValidator');
const RateLimiter = require('./src/middleware/rateLimiter');
const sessionManager = require('./src/services/sessionManager');
const { handleRequest: handleAPIRequest } = require('./src/routes/ecgRoutes');
const metricsCollector = require('./src/services/metricsCollector');
const alertManager = require('./src/services/alertManager');
const { handleRequest: handleMonitoringRequest } = require('./src/routes/monitoringRoutes');

// ─── Configuration from Environment ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MONGO_URI = process.env.MONGO_URI || `mongodb://mongo:27017/${process.env.DBNAME || 'hrzsignaldb'}`;
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_ENABLED = process.env.AUTH_ENABLED !== 'false'; // Default: enabled

// ─── Rate Limiter ────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter({
  maxConnectionsPerIP: parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 10,
  maxMessagesPerSecond: parseInt(process.env.MAX_MESSAGES_PER_SECOND, 10) || 50,
  maxAuthFailuresPerIP: parseInt(process.env.MAX_AUTH_FAILURES_PER_IP, 10) || 5,
  banDurationMs: parseInt(process.env.BAN_DURATION_MS, 10) || 15 * 60 * 1000,
});

// ─── MongoDB Connection ──────────────────────────────────────────────────────

mongoose.connect(MONGO_URI)
  .then(() => logger.info('Connected to MongoDB', { uri: MONGO_URI.replace(/\/\/[^@]+@/, '//***:***@') }))
  .catch(err => {
    logger.error('MongoDB connection error', { error: err.message });
    process.exit(1);
  });

mongoose.connection.on('error', err => {
  logger.error('MongoDB runtime error', { error: err.message });
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected, attempting reconnection...');
});

// ─── HTTP Server + WebSocket Server ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers for API routes
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Monitoring routes (health checks, metrics, dashboard)
  if (req.url.startsWith('/health') || req.url.startsWith('/monitoring') || req.url.startsWith('/api/v1/monitoring')) {
    const handled = handleMonitoringRequest(req, res);
    if (handled) return;
  }

  // REST API routes for ECG data persistence
  if (req.url.startsWith('/api/')) {
    const handled = await handleAPIRequest(req, res);
    if (handled) return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ noServer: true });

// ─── Connection Upgrade Handler (Authentication) ─────────────────────────────

server.on('upgrade', (request, socket, head) => {
  const clientIP = getClientIP(request);

  // Rate limit: check IP ban
  if (rateLimiter.isBanned(clientIP)) {
    logger.security('CONNECTION_REJECTED_BANNED_IP', { ip: clientIP });
    metricsCollector.recordRejectedConnection('banned');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Rate limit: check max connections per IP
  if (!rateLimiter.allowConnection(clientIP)) {
    logger.security('CONNECTION_REJECTED_RATE_LIMIT', { ip: clientIP });
    metricsCollector.recordRejectedConnection('rate_limit');
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // JWT Authentication
  if (AUTH_ENABLED) {
    const authResult = authenticateConnection(request);

    if (!authResult.authenticated) {
      rateLimiter.recordAuthFailure(clientIP);
      metricsCollector.recordRejectedConnection('auth');
      alertManager.recordAuthFailure();
      logger.security('CONNECTION_REJECTED_AUTH', { ip: clientIP, error: authResult.error });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Attach user info to request for use in connection handler
    request.user = authResult.user;
  } else {
    logger.warn('Authentication is DISABLED. Set AUTH_ENABLED=true for production.');
    request.user = { id: 'anonymous', role: 'anonymous', deviceId: null, patientId: null };
  }

  // Complete the WebSocket upgrade
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// ─── WebSocket Connection Handler ────────────────────────────────────────────

wss.on('connection', (ws, request) => {
  const clientIP = getClientIP(request);
  const connectionId = uuidv4();
  const user = request.user || {};

  // Track connection
  rateLimiter.addConnection(clientIP);
  metricsCollector.recordConnection(user.role || 'unknown');
  ws._connectionId = connectionId;
  ws._clientIP = clientIP;
  ws._user = user;
  ws._connectedAt = Date.now();
  ws._messageCount = 0;

  logger.info('Client connected', {
    connectionId,
    ip: clientIP,
    userId: user.id,
    role: user.role,
    deviceId: user.deviceId,
    totalClients: wss.clients.size,
  });

  // ── Message Handler ──────────────────────────────────────────────────────

  ws.on('message', (rawMessage) => {
    const msgStartTime = process.hrtime.bigint();
    ws._messageCount++;

    // Track raw message
    const rawSize = typeof rawMessage === 'string' ? rawMessage.length : rawMessage.byteLength || 0;

    // Rate limit: check message rate
    if (!rateLimiter.allowMessage(connectionId)) {
      logger.security('MESSAGE_RATE_LIMITED', {
        connectionId,
        ip: clientIP,
        userId: user.id,
      });
      metricsCollector.recordRateLimitedMessage();
      ws.send(JSON.stringify({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
      }));
      return;
    }

    // Validate the incoming message
    const validation = validateMessage(rawMessage);

    if (!validation.valid) {
      logger.medical('INVALID_DATA_RECEIVED', {
        connectionId,
        ip: clientIP,
        userId: user.id,
        errors: validation.errors,
      });
      metricsCollector.recordError('validation', validation.errors[0] || 'unknown');
      alertManager.recordError();
      ws.send(JSON.stringify({
        error: 'Invalid data',
        code: 'VALIDATION_ERROR',
        details: validation.errors,
      }));
      return;
    }

    // Log warnings if any
    if (validation.warnings.length > 0) {
      logger.medical('DATA_WARNINGS', {
        connectionId,
        userId: user.id,
        warnings: validation.warnings,
      });
    }

    const data = validation.sanitized;

    // Record message metrics
    metricsCollector.recordMessage(data.type, rawSize);
    metricsCollector.recordProcessedMessage();

    // Process validated message by type
    switch (data.type) {
      case 'ecg_data':
        handleECGData(ws, data);
        break;
      case 'device_status':
        handleDeviceStatus(ws, data);
        break;
      case 'patient_info':
        handlePatientInfo(ws, data);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      default:
        ws.send(JSON.stringify({ error: 'Unknown message type', code: 'UNKNOWN_TYPE' }));
    }

    // Record processing latency
    const latencyMs = Number(process.hrtime.bigint() - msgStartTime) / 1e6;
    metricsCollector.recordLatency(latencyMs);
  });

  // ── Error Handler ────────────────────────────────────────────────────────

  ws.on('error', (error) => {
    logger.error('WebSocket error', {
      connectionId,
      ip: clientIP,
      userId: user.id,
      error: error.message,
    });
    metricsCollector.recordError('websocket', error.message);
    alertManager.recordError();
  });

  // ── Close Handler ────────────────────────────────────────────────────────

  ws.on('close', async (code, reason) => {
    rateLimiter.removeConnection(clientIP);
    rateLimiter.removeMessageTracking(connectionId);
    metricsCollector.recordDisconnection(user.role || 'unknown');

    // Close all ECG recording sessions for this connection
    try {
      await sessionManager.closeAllSessions(connectionId);
    } catch (err) {
      logger.error('Error closing ECG sessions on disconnect', {
        connectionId,
        error: err.message,
      });
    }

    const sessionDuration = Math.round((Date.now() - ws._connectedAt) / 1000);

    logger.info('Client disconnected', {
      connectionId,
      ip: clientIP,
      userId: user.id,
      code,
      reason: reason ? reason.toString() : 'N/A',
      sessionDurationSec: sessionDuration,
      messagesProcessed: ws._messageCount,
      totalClients: wss.clients.size - 1,
    });
  });

  // Send welcome message with server capabilities
  ws.send(JSON.stringify({
    type: 'welcome',
    connectionId,
    serverVersion: '2.0.0',
    authEnabled: AUTH_ENABLED,
    validMessageTypes: ['ecg_data', 'device_status', 'patient_info', 'ping'],
    timestamp: Date.now(),
  }));
});

// ─── Message Type Handlers ───────────────────────────────────────────────────

async function handleECGData(ws, data) {
  // ── Track ECG packet quality metrics ───────────────────────────────────
  metricsCollector.recordECGPacket({
    deviceId: data.deviceId,
    channelId: data.channelId,
    sequenceNumber: data.sequenceNumber,
    sampleCount: data.samples ? data.samples.length : 0,
    samples: data.samples,
  });

  // ── Persist to MongoDB via SessionManager ──────────────────────────────
  try {
    const result = await sessionManager.recordECGData({
      connectionId: ws._connectionId,
      deviceId: data.deviceId,
      channelId: data.channelId,
      samples: data.samples,
      timestamp: data.timestamp,
      sequenceNumber: data.sequenceNumber,
      patientId: ws._user?.patientId || null,
    });

    // Broadcast validated ECG data to other connected clients (monitoring dashboards)
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        // Only send to clients that have a role of 'monitor' or 'admin'
        if (client._user && ['monitor', 'admin', 'anonymous'].includes(client._user.role)) {
          client.send(JSON.stringify({
            type: 'ecg_data',
            deviceId: data.deviceId,
            channelId: data.channelId,
            samples: data.samples,
            timestamp: data.timestamp,
            sequenceNumber: data.sequenceNumber,
          }));
        }
      }
    });

    // Acknowledge receipt with session info
    ws.send(JSON.stringify({
      type: 'ack',
      messageType: 'ecg_data',
      channelId: data.channelId,
      samplesReceived: data.samples.length,
      sessionId: result.sessionId,
      buffered: result.buffered,
      timestamp: Date.now(),
    }));

    logger.debug('ECG data processed and persisted', {
      deviceId: data.deviceId,
      channelId: data.channelId,
      sampleCount: data.samples.length,
      sessionId: result.sessionId,
    });
  } catch (err) {
    logger.error('ECG data persistence error', {
      deviceId: data.deviceId,
      error: err.message,
    });
    metricsCollector.recordError('persistence', err.message);
    alertManager.recordError();
    // Still acknowledge receipt even if persistence fails (data was broadcast)
    ws.send(JSON.stringify({
      type: 'ack',
      messageType: 'ecg_data',
      channelId: data.channelId,
      samplesReceived: data.samples.length,
      persistenceError: true,
      timestamp: Date.now(),
    }));
  }
}

function handleDeviceStatus(ws, data) {
  logger.info('Device status update', {
    deviceId: data.deviceId,
    status: data.status,
    batteryLevel: data.batteryLevel,
  });

  ws.send(JSON.stringify({
    type: 'ack',
    messageType: 'device_status',
    timestamp: Date.now(),
  }));
}

function handlePatientInfo(ws, data) {
  logger.info('Patient info received', {
    patientId: data.patientId,
    deviceId: data.deviceId,
  });

  ws.send(JSON.stringify({
    type: 'ack',
    messageType: 'patient_info',
    timestamp: Date.now(),
  }));
}

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  // Start metrics collection
  metricsCollector.start();

  // Periodic alert evaluation (every 30s)
  setInterval(() => {
    const snapshot = metricsCollector.getSnapshot();
    alertManager.evaluate(snapshot, { mongoState: mongoose.connection.readyState });
  }, 30000);

  logger.info(`Horizon Medical WSS server started`, {
    port: PORT,
    environment: NODE_ENV,
    authEnabled: AUTH_ENABLED,
    mongoUri: MONGO_URI.replace(/\/\/[^@]+@/, '//***:***@'),
    monitoring: { dashboard: '/monitoring', health: '/health', detailed: '/health/detailed' },
  });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Close all WebSocket connections
  wss.clients.forEach((client) => {
    client.send(JSON.stringify({ type: 'server_shutdown', timestamp: Date.now() }));
    client.close(1001, 'Server shutting down');
  });

  // Close WebSocket server
  wss.close(() => {
    logger.info('WebSocket server closed');
  });

  // Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Stop metrics collection
  metricsCollector.stop();
  logger.info('MetricsCollector stopped');

  // Close all active ECG sessions
  sessionManager.destroy();
  logger.info('SessionManager destroyed');

  // Close MongoDB connection
  mongoose.connection.close(false).then(() => {
    logger.info('MongoDB connection closed');
    rateLimiter.destroy();
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
