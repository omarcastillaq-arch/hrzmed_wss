/**
 * @module notificationRoutes
 * @description REST API routes for the notification system.
 *
 * Routes:
 *   GET    /api/v1/notifications             - List notifications with filters
 *   GET    /api/v1/notifications/stats        - Get notification statistics
 *   GET    /api/v1/notifications/unread-count - Get unread notification count
 *   GET    /api/v1/notifications/:id          - Get notification detail
 *   POST   /api/v1/notifications/test         - Send a test notification
 *   PUT    /api/v1/notifications/:id/read     - Mark notification as read
 *   PUT    /api/v1/notifications/:id/acknowledge - Acknowledge notification
 *   GET    /api/v1/notifications/preferences  - Get notification preferences
 *   PUT    /api/v1/notifications/preferences  - Update notification preferences
 */

'use strict';

const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const notificationService = require('../services/notification-service');
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

async function handleNotificationRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  try {
    // GET /api/v1/notifications/stats
    if (path === '/api/v1/notifications/stats' && method === 'GET') {
      return await getStats(req, res);
    }

    // GET /api/v1/notifications/unread-count
    if (path === '/api/v1/notifications/unread-count' && method === 'GET') {
      return await getUnreadCount(req, res);
    }

    // GET /api/v1/notifications/preferences
    if (path === '/api/v1/notifications/preferences' && method === 'GET') {
      return await getPreferences(req, res);
    }

    // PUT /api/v1/notifications/preferences
    if (path === '/api/v1/notifications/preferences' && method === 'PUT') {
      return await updatePreferences(req, res);
    }

    // POST /api/v1/notifications/test
    if (path === '/api/v1/notifications/test' && method === 'POST') {
      return await sendTestNotification(req, res);
    }

    // GET /api/v1/notifications
    if (path === '/api/v1/notifications' && method === 'GET') {
      return await listNotifications(req, res);
    }

    // Match /api/v1/notifications/:id/read
    const readMatch = path.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
    if (readMatch && method === 'PUT') {
      return await markAsRead(req, res, readMatch[1]);
    }

    // Match /api/v1/notifications/:id/acknowledge
    const ackMatch = path.match(/^\/api\/v1\/notifications\/([^/]+)\/acknowledge$/);
    if (ackMatch && method === 'PUT') {
      return await acknowledgeNotification(req, res, ackMatch[1]);
    }

    // Match /api/v1/notifications/:id
    const idMatch = path.match(/^\/api\/v1\/notifications\/([^/]+)$/);
    if (idMatch && method === 'GET') {
      return await getNotification(req, res, idMatch[1]);
    }

    return null; // Not handled

  } catch (err) {
    logger.error('Notification route error', { error: err.message, path, method });
    sendJSON(res, 500, { error: 'Internal server error', message: err.message });
    return true;
  }
}

// ─── Route Implementations ───────────────────────────────────────────────────

async function listNotifications(req, res) {
  const query = parseQuery(req.url);
  const { page, limit, skip } = parsePagination(query);

  const filter = {};

  // Severity filter
  if (query.severity) {
    const severities = query.severity.split(',').map(s => s.trim().toUpperCase());
    filter.severity = { $in: severities };
  }

  // Type filter
  if (query.type) {
    filter.type = query.type;
  }

  // Status filter
  if (query.status) {
    filter.status = query.status;
  }

  // Date range filter
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  // Device filter
  if (query.deviceId) {
    filter['source.deviceId'] = query.deviceId;
  }

  // Patient filter
  if (query.patientId) {
    filter['source.patientId'] = query.patientId;
  }

  // Sort
  const sortField = query.sort || '-createdAt';
  const sort = {};
  if (sortField.startsWith('-')) {
    sort[sortField.substring(1)] = -1;
  } else {
    sort[sortField] = 1;
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);

  sendJSON(res, 200, {
    success: true,
    data: notifications,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
  return true;
}

async function getNotification(req, res, id) {
  const notification = await Notification.findOne({ notificationId: id }).lean();
  if (!notification) {
    sendJSON(res, 404, { error: 'Notification not found' });
    return true;
  }
  sendJSON(res, 200, { success: true, data: notification });
  return true;
}

async function getStats(req, res) {
  const query = parseQuery(req.url);
  const days = parseInt(query.days, 10) || 30;
  const stats = await Notification.getStats(days);
  sendJSON(res, 200, { success: true, data: stats });
  return true;
}

async function getUnreadCount(req, res) {
  const count = await Notification.countDocuments({ status: { $in: ['pending', 'sent'] } });
  sendJSON(res, 200, { success: true, data: { unread: count } });
  return true;
}

async function markAsRead(req, res, id) {
  const notification = await Notification.findOneAndUpdate(
    { notificationId: id },
    { status: 'read', readAt: new Date() },
    { new: true },
  );
  if (!notification) {
    sendJSON(res, 404, { error: 'Notification not found' });
    return true;
  }
  sendJSON(res, 200, { success: true, data: notification.toSafeJSON() });
  return true;
}

async function acknowledgeNotification(req, res, id) {
  const body = await parseBody(req);
  const notification = await Notification.findOneAndUpdate(
    { notificationId: id },
    {
      status: 'acknowledged',
      acknowledgedAt: new Date(),
      acknowledgedBy: body.acknowledgedBy || 'unknown',
    },
    { new: true },
  );
  if (!notification) {
    sendJSON(res, 404, { error: 'Notification not found' });
    return true;
  }
  sendJSON(res, 200, { success: true, data: notification.toSafeJSON() });
  return true;
}

async function sendTestNotification(req, res) {
  const body = await parseBody(req);
  const notification = await notificationService.createNotification({
    type: 'test_notification',
    severity: body.severity || 'LOW',
    title: body.title || 'Notificación de Prueba',
    message: body.message || 'Esta es una notificación de prueba del sistema Horizon Medical. Si recibe este mensaje, el sistema de notificaciones está funcionando correctamente.',
    source: body.source || {},
    metadata: { test: true, triggeredBy: body.triggeredBy || 'api' },
  });

  if (!notification) {
    sendJSON(res, 429, { error: 'Notification suppressed or rate limited' });
    return true;
  }

  sendJSON(res, 201, { success: true, data: notification.toSafeJSON() });
  return true;
}

async function getPreferences(req, res) {
  const query = parseQuery(req.url);
  const userId = query.userId || 'default';

  let prefs = await NotificationPreference.findOne({ userId }).lean();
  if (!prefs) {
    // Return default preferences
    prefs = {
      userId,
      email: process.env.NOTIF_DEFAULT_EMAIL || '',
      enabled: true,
      channels: { email: true, websocket: true, dashboard: true },
      severityFilter: { CRITICAL: true, HIGH: true, MEDIUM: true, LOW: false },
      typeFilter: {
        arrhythmia_detected: true,
        device_disconnected: true,
        battery_low: true,
        signal_quality_degraded: true,
        system_error: true,
        session_anomaly: true,
        connection_lost: true,
        test_notification: true,
      },
      quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'UTC', overrideForCritical: true },
      dailyDigest: { enabled: false, time: '08:00' },
    };
  }

  sendJSON(res, 200, { success: true, data: prefs });
  return true;
}

async function updatePreferences(req, res) {
  const body = await parseBody(req);
  const userId = body.userId || 'default';

  if (!body.email) {
    sendJSON(res, 400, { error: 'Email is required' });
    return true;
  }

  const update = {
    userId,
    email: body.email,
    name: body.name || '',
    enabled: body.enabled !== false,
  };

  if (body.channels) update.channels = body.channels;
  if (body.severityFilter) update.severityFilter = body.severityFilter;
  if (body.typeFilter) update.typeFilter = body.typeFilter;
  if (body.quietHours) update.quietHours = body.quietHours;
  if (body.dailyDigest) update.dailyDigest = body.dailyDigest;

  const prefs = await NotificationPreference.findOneAndUpdate(
    { userId },
    update,
    { new: true, upsert: true, runValidators: true },
  );

  sendJSON(res, 200, { success: true, data: prefs });
  return true;
}

module.exports = handleNotificationRoutes;
