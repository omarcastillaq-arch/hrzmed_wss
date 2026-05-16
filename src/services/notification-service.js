/**
 * @module notification-service
 * @description Complete notification system for Horizon Medical WSS.
 *
 * Features:
 *   - Event detection: arrhythmias, disconnections, battery low, signal degraded
 *   - Severity levels: CRITICAL, HIGH, MEDIUM, LOW
 *   - Priority queue with rate limiting
 *   - Email delivery via Nodemailer (SMTP)
 *   - WebSocket real-time push to dashboard
 *   - MongoDB persistence for notification history
 *   - Retry logic for failed deliveries
 *   - Suppression of duplicate/spam notifications
 *
 * @see Phase 16 - Notification System
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');

// ─── Severity Definitions ────────────────────────────────────────────────────

const SEVERITY = {
  CRITICAL: 'CRITICAL',  // Immediate action required (dangerous arrhythmia)
  HIGH: 'HIGH',          // Urgent attention needed (device disconnected during session)
  MEDIUM: 'MEDIUM',      // Important information (battery low)
  LOW: 'LOW',            // Informational (signal quality notice)
};

const SEVERITY_PRIORITY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  // Rate limiting: max notifications per type per time window
  rateLimitWindowMs: parseInt(process.env.NOTIF_RATE_LIMIT_WINDOW_MS, 10) || 5 * 60 * 1000,
  rateLimitMaxPerType: parseInt(process.env.NOTIF_RATE_LIMIT_MAX, 10) || 10,
  // Retry
  maxRetries: parseInt(process.env.NOTIF_MAX_RETRIES, 10) || 3,
  retryDelayMs: parseInt(process.env.NOTIF_RETRY_DELAY_MS, 10) || 30000,
  // Queue processing interval
  queueIntervalMs: parseInt(process.env.NOTIF_QUEUE_INTERVAL_MS, 10) || 2000,
  // Default email recipient
  defaultEmailRecipient: process.env.NOTIF_DEFAULT_EMAIL || '',
  // Suppression: same notification type+device within this window is suppressed
  suppressionWindowMs: parseInt(process.env.NOTIF_SUPPRESSION_WINDOW_MS, 10) || 60000,
};

// ─── Email Transport ─────────────────────────────────────────────────────────

let emailTransport = null;

function initEmailTransport() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT, 10) || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || 'Horizon Medical <noreply@horizon-medical.com>';
  const smtpSecure = process.env.SMTP_SECURE === 'true';

  if (!smtpHost || !smtpUser || !smtpPass) {
    logger.warn('Email notifications disabled: SMTP_HOST, SMTP_USER, or SMTP_PASS not configured');
    return null;
  }

  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: smtpUser, pass: smtpPass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    rateLimit: 5,
  });

  transport.verify((err) => {
    if (err) {
      logger.error('SMTP transport verification failed', { error: err.message });
    } else {
      logger.info('SMTP transport ready', { host: smtpHost, port: smtpPort });
    }
  });

  emailTransport = transport;
  return transport;
}

// ─── Priority Queue ──────────────────────────────────────────────────────────

class NotificationQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.intervalId = null;
  }

  enqueue(notification) {
    // Insert by priority (lower = higher priority)
    const priority = SEVERITY_PRIORITY[notification.severity] ?? 3;
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      const itemPriority = SEVERITY_PRIORITY[this.queue[i].severity] ?? 3;
      if (priority < itemPriority) {
        this.queue.splice(i, 0, notification);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.queue.push(notification);
    return this.queue.length;
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  size() {
    return this.queue.length;
  }

  clear() {
    this.queue = [];
  }
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class NotificationRateLimiter {
  constructor() {
    this.counters = new Map(); // key -> { count, windowStart }
  }

  allow(key) {
    const now = Date.now();
    const entry = this.counters.get(key);

    if (!entry || (now - entry.windowStart) >= CONFIG.rateLimitWindowMs) {
      this.counters.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= CONFIG.rateLimitMaxPerType) {
      return false;
    }

    entry.count++;
    return true;
  }

  reset() {
    this.counters.clear();
  }
}

// ─── Suppression Tracker ─────────────────────────────────────────────────────

class SuppressionTracker {
  constructor() {
    this.recent = new Map(); // key -> timestamp
  }

  isDuplicate(type, deviceId) {
    const key = `${type}:${deviceId || 'system'}`;
    const now = Date.now();
    const lastSeen = this.recent.get(key);

    if (lastSeen && (now - lastSeen) < CONFIG.suppressionWindowMs) {
      return true;
    }

    this.recent.set(key, now);
    return false;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, ts] of this.recent) {
      if ((now - ts) >= CONFIG.suppressionWindowMs * 2) {
        this.recent.delete(key);
      }
    }
  }
}

// ─── Email Templates ─────────────────────────────────────────────────────────

function generateEmailHTML(notification) {
  const severityColors = {
    CRITICAL: '#DC2626',
    HIGH: '#EA580C',
    MEDIUM: '#D97706',
    LOW: '#2563EB',
  };
  const severityEmoji = {
    CRITICAL: '🚨',
    HIGH: '⚠️',
    MEDIUM: '📋',
    LOW: 'ℹ️',
  };

  const color = severityColors[notification.severity] || '#6B7280';
  const emoji = severityEmoji[notification.severity] || '';
  const timestamp = new Date(notification.createdAt || Date.now()).toISOString();

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
  <!-- Header -->
  <tr><td style="background: linear-gradient(135deg, #0891b2 0%, #1d4ed8 100%);padding:24px 32px;text-align:center;">
    <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;">❤️ Horizon Medical</h1>
    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Sistema de Notificaciones</p>
  </td></tr>
  <!-- Severity Badge -->
  <tr><td style="padding:24px 32px 0;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="background-color:${color};color:#fff;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:0.5px;">${emoji} ${notification.severity}</td>
    </tr></table>
  </td></tr>
  <!-- Title -->
  <tr><td style="padding:16px 32px 0;">
    <h2 style="margin:0;font-size:18px;color:#111827;font-weight:600;">${escapeHtml(notification.title)}</h2>
  </td></tr>
  <!-- Message -->
  <tr><td style="padding:12px 32px;">
    <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.6;">${escapeHtml(notification.message)}</p>
  </td></tr>
  <!-- Details -->
  <tr><td style="padding:0 32px 24px;">
    <table width="100%" cellpadding="8" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;margin-top:8px;">
      <tr><td style="font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;"><strong>Tipo:</strong></td><td style="font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${notification.type}</td></tr>
      ${notification.source?.deviceId ? `<tr><td style="font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;"><strong>Dispositivo:</strong></td><td style="font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${escapeHtml(notification.source.deviceId)}</td></tr>` : ''}
      ${notification.source?.patientId ? `<tr><td style="font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;"><strong>Paciente:</strong></td><td style="font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${escapeHtml(notification.source.patientId)}</td></tr>` : ''}
      <tr><td style="font-size:12px;color:#6b7280;"><strong>Fecha/Hora:</strong></td><td style="font-size:12px;color:#374151;">${timestamp}</td></tr>
    </table>
  </td></tr>
  <!-- Footer -->
  <tr><td style="background-color:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:11px;color:#9ca3af;">Esta es una notificación automática del sistema Horizon Medical.<br>No responda a este correo.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateEmailSubject(notification) {
  const prefix = {
    CRITICAL: '🚨 URGENTE',
    HIGH: '⚠️ ALERTA',
    MEDIUM: '📋 Aviso',
    LOW: 'ℹ️ Info',
  };
  return `[Horizon Medical] ${prefix[notification.severity] || ''}: ${notification.title}`;
}

// ─── WebSocket Broadcaster Reference ─────────────────────────────────────────

let wssRef = null;

function setWebSocketServer(wss) {
  wssRef = wss;
}

function broadcastToClients(notification) {
  if (!wssRef) return 0;
  let sent = 0;
  const payload = JSON.stringify({
    type: 'notification',
    data: {
      notificationId: notification.notificationId,
      type: notification.type,
      severity: notification.severity,
      title: notification.title,
      message: notification.message,
      source: notification.source,
      createdAt: notification.createdAt || new Date().toISOString(),
    },
  });

  wssRef.clients.forEach((client) => {
    if (client.readyState === 1 && client._user &&
        ['monitor', 'admin', 'anonymous'].includes(client._user.role)) {
      try {
        client.send(payload);
        sent++;
      } catch (e) { /* ignore send errors */ }
    }
  });
  return sent;
}

// ─── Main Notification Service ───────────────────────────────────────────────

const queue = new NotificationQueue();
const rateLimiter = new NotificationRateLimiter();
const suppression = new SuppressionTracker();
let queueIntervalId = null;
let cleanupIntervalId = null;

/**
 * Create and dispatch a notification.
 * @param {Object} opts
 * @param {string} opts.type - Notification type
 * @param {string} opts.severity - CRITICAL, HIGH, MEDIUM, LOW
 * @param {string} opts.title - Short title
 * @param {string} opts.message - Detailed message
 * @param {Object} [opts.source] - { deviceId, patientId, sessionId, connectionId }
 * @param {Object} [opts.metadata] - Additional data
 * @returns {Object|null} The created notification document, or null if suppressed
 */
async function createNotification({ type, severity, title, message, source = {}, metadata = {} }) {
  // Validate severity
  if (!SEVERITY[severity]) {
    logger.warn('Invalid notification severity', { severity, type });
    severity = SEVERITY.MEDIUM;
  }

  // Suppression check (avoid duplicate spam) - skip for test notifications
  const isTestNotification = type === 'test_notification' || (metadata && metadata.test === true);
  if (!isTestNotification && suppression.isDuplicate(type, source.deviceId)) {
    logger.debug('Notification suppressed (duplicate)', { type, deviceId: source.deviceId });
    return null;
  }

  // Rate limit check - skip for test notifications
  const rateLimitKey = `${type}:${source.deviceId || 'system'}`;
  if (!isTestNotification && !rateLimiter.allow(rateLimitKey)) {
    logger.warn('Notification rate limited', { type, deviceId: source.deviceId });
    // Still save but mark as suppressed
    const suppressed = new Notification({
      notificationId: uuidv4(),
      type, severity, title, message, source, metadata,
      status: 'suppressed',
      suppressedReason: 'rate_limited',
    });
    await suppressed.save().catch(e => logger.error('Failed to save suppressed notification', { error: e.message }));
    return null;
  }

  // Create notification document
  const notification = new Notification({
    notificationId: uuidv4(),
    type,
    severity,
    title,
    message,
    source,
    metadata,
    status: 'pending',
    maxRetries: CONFIG.maxRetries,
  });

  try {
    await notification.save();
    logger.info('Notification created', {
      notificationId: notification.notificationId,
      type, severity,
      deviceId: source.deviceId,
    });
  } catch (err) {
    logger.error('Failed to save notification', { error: err.message, type, severity });
    return null;
  }

  // Enqueue for delivery
  queue.enqueue(notification);

  // Immediate WebSocket broadcast for all notifications
  const wsSent = broadcastToClients(notification);
  logger.debug('Notification broadcast via WebSocket', { notificationId: notification.notificationId, clientsReached: wsSent });

  return notification;
}

/**
 * Process the notification queue - send emails for pending notifications.
 */
async function processQueue() {
  if (queue.size() === 0) return;

  const batch = [];
  const maxBatch = 5;
  while (queue.size() > 0 && batch.length < maxBatch) {
    batch.push(queue.dequeue());
  }

  for (const notification of batch) {
    try {
      await deliverNotification(notification);
    } catch (err) {
      logger.error('Error delivering notification', {
        notificationId: notification.notificationId,
        error: err.message,
      });
      // Retry logic
      if (notification.retryCount < notification.maxRetries) {
        notification.retryCount++;
        notification.lastRetryAt = new Date();
        queue.enqueue(notification);
        await Notification.findOneAndUpdate(
          { notificationId: notification.notificationId },
          { retryCount: notification.retryCount, lastRetryAt: notification.lastRetryAt },
        ).catch(() => {});
      } else {
        await Notification.findOneAndUpdate(
          { notificationId: notification.notificationId },
          { status: 'failed' },
        ).catch(() => {});
      }
    }
  }
}

/**
 * Deliver a notification via email to all eligible recipients.
 */
async function deliverNotification(notification) {
  // Get all preferences or use default recipient
  let recipients = [];

  try {
    const prefs = await NotificationPreference.find({ enabled: true }).lean();
    for (const pref of prefs) {
      if (pref.channels && pref.channels.email !== false) {
        const shouldSend = NotificationPreference.hydrate(pref).shouldNotify(notification.type, notification.severity);
        if (shouldSend) {
          recipients.push({ email: pref.email, name: pref.name || pref.userId });
        }
      }
    }
  } catch (err) {
    logger.error('Failed to fetch notification preferences', { error: err.message });
  }

  // Fallback to default email if no preferences found
  if (recipients.length === 0 && CONFIG.defaultEmailRecipient) {
    recipients.push({ email: CONFIG.defaultEmailRecipient, name: 'Admin' });
  }

  if (recipients.length === 0 || !emailTransport) {
    // No recipients or no email transport - mark as sent (WebSocket only)
    await Notification.findOneAndUpdate(
      { notificationId: notification.notificationId },
      { status: 'sent', recipients: [] },
    ).catch(() => {});
    return;
  }

  // Send emails
  const recipientResults = [];
  const smtpFrom = process.env.SMTP_FROM || 'Horizon Medical <noreply@horizon-medical.com>';

  for (const recipient of recipients) {
    const result = { email: recipient.email, name: recipient.name, sentAt: new Date(), deliveryStatus: 'pending' };
    try {
      await emailTransport.sendMail({
        from: smtpFrom,
        to: recipient.email,
        subject: generateEmailSubject(notification),
        html: generateEmailHTML(notification),
      });
      result.deliveryStatus = 'sent';
      result.sentAt = new Date();
    } catch (err) {
      result.deliveryStatus = 'failed';
      result.error = err.message;
      logger.error('Email delivery failed', {
        notificationId: notification.notificationId,
        recipient: recipient.email,
        error: err.message,
      });
    }
    recipientResults.push(result);
  }

  const allSent = recipientResults.every(r => r.deliveryStatus === 'sent');
  const anySent = recipientResults.some(r => r.deliveryStatus === 'sent');

  await Notification.findOneAndUpdate(
    { notificationId: notification.notificationId },
    {
      status: allSent ? 'sent' : (anySent ? 'sent' : 'failed'),
      recipients: recipientResults,
    },
  ).catch(() => {});
}

// ─── Event Detectors ─────────────────────────────────────────────────────────

/**
 * Detect dangerous arrhythmia from Edge AI classification.
 * @param {Object} data - { classification, confidence, deviceId, patientId, sessionId }
 */
async function detectArrhythmia(data) {
  const { classification, confidence, deviceId, patientId, sessionId } = data;
  const dangerousTypes = ['ventricular_fibrillation', 'ventricular_tachycardia', 'asystole', 'abnormal'];

  if (!dangerousTypes.includes(classification)) return null;

  const severity = (classification === 'ventricular_fibrillation' || classification === 'asystole')
    ? SEVERITY.CRITICAL
    : (confidence > 0.9 ? SEVERITY.HIGH : SEVERITY.MEDIUM);

  const classNames = {
    ventricular_fibrillation: 'Fibrilación Ventricular',
    ventricular_tachycardia: 'Taquicardia Ventricular',
    asystole: 'Asistolia',
    abnormal: 'ECG Anormal',
  };

  return createNotification({
    type: 'arrhythmia_detected',
    severity,
    title: `Arritmia Detectada: ${classNames[classification] || classification}`,
    message: `Se ha detectado ${classNames[classification] || classification} en el dispositivo ${deviceId}${patientId ? ` (paciente: ${patientId})` : ''}. Confianza del modelo: ${(confidence * 100).toFixed(1)}%. Se requiere revisión médica inmediata.`,
    source: { deviceId, patientId, sessionId },
    metadata: { classification, confidence },
  });
}

/**
 * Detect device disconnection.
 */
async function detectDeviceDisconnection(data) {
  const { deviceId, patientId, sessionId, connectionId, reason } = data;

  return createNotification({
    type: 'device_disconnected',
    severity: sessionId ? SEVERITY.HIGH : SEVERITY.MEDIUM,
    title: `Dispositivo Desconectado: ${deviceId}`,
    message: `El dispositivo ${deviceId} se ha desconectado${patientId ? ` del paciente ${patientId}` : ''}${sessionId ? ' durante una sesión activa de ECG' : ''}. Razón: ${reason || 'desconocida'}.`,
    source: { deviceId, patientId, sessionId, connectionId },
    metadata: { reason },
  });
}

/**
 * Detect low battery.
 */
async function detectBatteryLow(data) {
  const { deviceId, batteryLevel, patientId } = data;

  if (batteryLevel >= 20) return null;

  const severity = batteryLevel < 5 ? SEVERITY.HIGH : SEVERITY.MEDIUM;

  return createNotification({
    type: 'battery_low',
    severity,
    title: `Batería Baja: ${deviceId} (${batteryLevel}%)`,
    message: `El dispositivo ${deviceId} tiene un nivel de batería de ${batteryLevel}%. ${batteryLevel < 5 ? 'Se recomienda recarga inmediata para evitar interrupción del monitoreo.' : 'Por favor planifique la recarga del dispositivo.'}`,
    source: { deviceId, patientId },
    metadata: { batteryLevel },
  });
}

/**
 * Detect degraded signal quality.
 */
async function detectSignalQualityDegraded(data) {
  const { deviceId, patientId, sessionId, snrDb, qualityScore } = data;

  const threshold = parseFloat(process.env.ALERT_ECG_MIN_SNR_DB) || 10;
  if (snrDb >= threshold && (qualityScore === undefined || qualityScore >= 0.5)) return null;

  return createNotification({
    type: 'signal_quality_degraded',
    severity: snrDb < 5 ? SEVERITY.HIGH : SEVERITY.LOW,
    title: `Calidad de Señal Degradada: ${deviceId}`,
    message: `La calidad de señal del dispositivo ${deviceId} ha disminuido. SNR: ${snrDb?.toFixed(1) || 'N/A'} dB${qualityScore !== undefined ? `, Score: ${(qualityScore * 100).toFixed(0)}%` : ''}. Verifique la colocación de electrodos.`,
    source: { deviceId, patientId, sessionId },
    metadata: { snrDb, qualityScore },
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function start() {
  initEmailTransport();

  // Process queue periodically
  queueIntervalId = setInterval(() => {
    processQueue().catch(err => logger.error('Queue processing error', { error: err.message }));
  }, CONFIG.queueIntervalMs);

  // Cleanup suppression tracker periodically
  cleanupIntervalId = setInterval(() => {
    suppression.cleanup();
  }, CONFIG.suppressionWindowMs * 2);

  logger.info('Notification service started', {
    emailEnabled: !!emailTransport,
    defaultRecipient: CONFIG.defaultEmailRecipient || 'none',
    rateLimitWindow: CONFIG.rateLimitWindowMs,
    rateLimitMax: CONFIG.rateLimitMaxPerType,
  });
}

function stop() {
  if (queueIntervalId) clearInterval(queueIntervalId);
  if (cleanupIntervalId) clearInterval(cleanupIntervalId);
  if (emailTransport) emailTransport.close();
  queue.clear();
  rateLimiter.reset();
  logger.info('Notification service stopped');
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  SEVERITY,
  SEVERITY_PRIORITY,

  // Core functions
  createNotification,
  processQueue,
  deliverNotification,

  // Event detectors
  detectArrhythmia,
  detectDeviceDisconnection,
  detectBatteryLow,
  detectSignalQualityDegraded,

  // WebSocket integration
  setWebSocketServer,
  broadcastToClients,

  // Lifecycle
  start,
  stop,

  // Email (for testing)
  generateEmailHTML,
  generateEmailSubject,
  initEmailTransport,

  // Internal classes (exported for testing)
  _queue: queue,
  _rateLimiter: rateLimiter,
  _suppression: suppression,
  NotificationQueue,
  NotificationRateLimiter,
  SuppressionTracker,
};
