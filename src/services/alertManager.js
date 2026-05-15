/**
 * @module alertManager
 * @description Basic alerting system for the Horizon Medical WSS server.
 *
 * Monitors key metrics and triggers alerts when thresholds are exceeded.
 * Alerts are logged via Winston and stored in-memory for dashboard display.
 *
 * Alert levels:
 *   - INFO: Informational events
 *   - WARNING: Degraded performance, approaching limits
 *   - CRITICAL: System health issues requiring immediate attention
 *
 * Supported alert rules:
 *   - High connection count
 *   - High error rate
 *   - High memory usage
 *   - High event loop lag
 *   - MongoDB disconnection
 *   - High ECG packet loss rate
 *   - Low ECG signal quality (SNR)
 *   - Authentication failure spike
 */

'use strict';

const logger = require('../utils/logger');

// ─── Configuration (thresholds) ──────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  maxConnections: parseInt(process.env.ALERT_MAX_CONNECTIONS, 10) || 100,
  errorRatePerMinute: parseInt(process.env.ALERT_ERROR_RATE, 10) || 50,
  memoryUsagePercent: parseInt(process.env.ALERT_MEMORY_PERCENT, 10) || 85,
  eventLoopLagMs: parseInt(process.env.ALERT_EVENT_LOOP_LAG_MS, 10) || 500,
  ecgPacketLossPercent: parseFloat(process.env.ALERT_ECG_PACKET_LOSS, 10) || 5,
  ecgMinSNRDb: parseFloat(process.env.ALERT_ECG_MIN_SNR_DB, 10) || 10,
  authFailuresPerMinute: parseInt(process.env.ALERT_AUTH_FAILURES, 10) || 10,
  heapUsagePercent: parseInt(process.env.ALERT_HEAP_PERCENT, 10) || 90,
};

// ─── Alert State ─────────────────────────────────────────────────────────────

const ALERT_LEVELS = { INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' };

/** @type {Array<Object>} In-memory alert log */
const alertLog = [];
const MAX_ALERT_LOG = 200;

/** Track active alerts to avoid duplicate spam */
const activeAlerts = new Map(); // ruleId -> { level, firstTriggered, lastTriggered, count }

/** Cooldown period between repeated alerts of the same type (ms) */
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS, 10) || 60000;

/** Counters for rate-based alerts */
const _counters = {
  errorsLastMinute: 0,
  authFailuresLastMinute: 0,
  _errorTimestamps: [],
  _authFailTimestamps: [],
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Evaluate all alert rules against the current metrics snapshot.
 * @param {Object} metricsSnapshot - From metricsCollector.getSnapshot()
 * @param {Object} [extraContext] - Additional context (e.g., mongoose state)
 */
function evaluate(metricsSnapshot, extraContext = {}) {
  if (!metricsSnapshot) return;

  const now = Date.now();

  // Clean up rate counters (keep last 60s)
  _counters._errorTimestamps = _counters._errorTimestamps.filter(t => now - t < 60000);
  _counters._authFailTimestamps = _counters._authFailTimestamps.filter(t => now - t < 60000);
  _counters.errorsLastMinute = _counters._errorTimestamps.length;
  _counters.authFailuresLastMinute = _counters._authFailTimestamps.length;

  const thresholds = DEFAULT_THRESHOLDS;

  // Rule 1: High connection count
  if (metricsSnapshot.connections && metricsSnapshot.connections.current >= thresholds.maxConnections) {
    triggerAlert('HIGH_CONNECTIONS', ALERT_LEVELS.WARNING,
      `Active connections (${metricsSnapshot.connections.current}) reached threshold (${thresholds.maxConnections})`,
      { current: metricsSnapshot.connections.current, threshold: thresholds.maxConnections }
    );
  } else {
    resolveAlert('HIGH_CONNECTIONS');
  }

  // Rule 2: High error rate
  if (_counters.errorsLastMinute >= thresholds.errorRatePerMinute) {
    triggerAlert('HIGH_ERROR_RATE', ALERT_LEVELS.CRITICAL,
      `Error rate (${_counters.errorsLastMinute}/min) exceeds threshold (${thresholds.errorRatePerMinute}/min)`,
      { rate: _counters.errorsLastMinute, threshold: thresholds.errorRatePerMinute }
    );
  } else {
    resolveAlert('HIGH_ERROR_RATE');
  }

  // Rule 3: High memory usage
  if (metricsSnapshot.system && metricsSnapshot.system.memoryUsage >= thresholds.memoryUsagePercent) {
    triggerAlert('HIGH_MEMORY', ALERT_LEVELS.WARNING,
      `Memory usage (${metricsSnapshot.system.memoryUsage}%) exceeds threshold (${thresholds.memoryUsagePercent}%)`,
      { usage: metricsSnapshot.system.memoryUsage, threshold: thresholds.memoryUsagePercent }
    );
  } else {
    resolveAlert('HIGH_MEMORY');
  }

  // Rule 4: High event loop lag
  if (metricsSnapshot.system && metricsSnapshot.system.eventLoopLag >= thresholds.eventLoopLagMs) {
    triggerAlert('HIGH_EVENT_LOOP_LAG', ALERT_LEVELS.CRITICAL,
      `Event loop lag (${metricsSnapshot.system.eventLoopLag}ms) exceeds threshold (${thresholds.eventLoopLagMs}ms)`,
      { lag: metricsSnapshot.system.eventLoopLag, threshold: thresholds.eventLoopLagMs }
    );
  } else {
    resolveAlert('HIGH_EVENT_LOOP_LAG');
  }

  // Rule 5: MongoDB disconnected
  if (extraContext.mongoState !== undefined && extraContext.mongoState !== 1) {
    triggerAlert('MONGODB_DISCONNECTED', ALERT_LEVELS.CRITICAL,
      `MongoDB is disconnected (state: ${extraContext.mongoState})`,
      { state: extraContext.mongoState }
    );
  } else if (extraContext.mongoState === 1) {
    resolveAlert('MONGODB_DISCONNECTED');
  }

  // Rule 6: High ECG packet loss
  if (metricsSnapshot.ecgQuality && metricsSnapshot.ecgQuality.packetLossRate >= thresholds.ecgPacketLossPercent) {
    triggerAlert('HIGH_ECG_PACKET_LOSS', ALERT_LEVELS.WARNING,
      `ECG packet loss rate (${metricsSnapshot.ecgQuality.packetLossRate}%) exceeds threshold (${thresholds.ecgPacketLossPercent}%)`,
      { rate: metricsSnapshot.ecgQuality.packetLossRate, threshold: thresholds.ecgPacketLossPercent }
    );
  } else {
    resolveAlert('HIGH_ECG_PACKET_LOSS');
  }

  // Rule 7: Low ECG SNR per device
  if (metricsSnapshot.ecgQuality && metricsSnapshot.ecgQuality.devices) {
    for (const [key, dev] of Object.entries(metricsSnapshot.ecgQuality.devices)) {
      if (dev.snrEstimateDb !== null && dev.snrEstimateDb < thresholds.ecgMinSNRDb) {
        triggerAlert(`LOW_ECG_SNR_${key}`, ALERT_LEVELS.WARNING,
          `Low ECG signal quality for ${key}: SNR ${dev.snrEstimateDb}dB < ${thresholds.ecgMinSNRDb}dB`,
          { device: key, snr: dev.snrEstimateDb, threshold: thresholds.ecgMinSNRDb }
        );
      } else {
        resolveAlert(`LOW_ECG_SNR_${key}`);
      }
    }
  }

  // Rule 8: Auth failure spike
  if (_counters.authFailuresLastMinute >= thresholds.authFailuresPerMinute) {
    triggerAlert('AUTH_FAILURE_SPIKE', ALERT_LEVELS.CRITICAL,
      `Authentication failures (${_counters.authFailuresLastMinute}/min) exceed threshold (${thresholds.authFailuresPerMinute}/min)`,
      { rate: _counters.authFailuresLastMinute, threshold: thresholds.authFailuresPerMinute }
    );
  } else {
    resolveAlert('AUTH_FAILURE_SPIKE');
  }

  // Rule 9: Heap usage
  if (metricsSnapshot.system) {
    const heapPercent = metricsSnapshot.system.heapTotal > 0
      ? Math.round((metricsSnapshot.system.heapUsed / metricsSnapshot.system.heapTotal) * 100)
      : 0;
    if (heapPercent >= thresholds.heapUsagePercent) {
      triggerAlert('HIGH_HEAP_USAGE', ALERT_LEVELS.WARNING,
        `Heap usage (${heapPercent}%) exceeds threshold (${thresholds.heapUsagePercent}%)`,
        { usage: heapPercent, threshold: thresholds.heapUsagePercent }
      );
    } else {
      resolveAlert('HIGH_HEAP_USAGE');
    }
  }
}

/**
 * Record an error event for rate counting.
 */
function recordError() {
  _counters._errorTimestamps.push(Date.now());
}

/**
 * Record an auth failure event for rate counting.
 */
function recordAuthFailure() {
  _counters._authFailTimestamps.push(Date.now());
}

/**
 * Get all active (unresolved) alerts.
 * @returns {Object[]}
 */
function getActiveAlerts() {
  const result = [];
  for (const [ruleId, alert] of activeAlerts) {
    result.push({ ruleId, ...alert });
  }
  return result;
}

/**
 * Get recent alert history.
 * @param {number} [count=50]
 * @returns {Object[]}
 */
function getAlertHistory(count = 50) {
  return alertLog.slice(-count);
}

/**
 * Get current thresholds configuration.
 * @returns {Object}
 */
function getThresholds() {
  return { ...DEFAULT_THRESHOLDS };
}

/**
 * Reset alert state (for testing).
 */
function reset() {
  alertLog.length = 0;
  activeAlerts.clear();
  _counters.errorsLastMinute = 0;
  _counters.authFailuresLastMinute = 0;
  _counters._errorTimestamps = [];
  _counters._authFailTimestamps = [];
}

// ─── Internal Functions ──────────────────────────────────────────────────────

function triggerAlert(ruleId, level, message, details = {}) {
  const now = Date.now();
  const existing = activeAlerts.get(ruleId);

  // Cooldown: don't log again if still within cooldown
  if (existing && (now - existing.lastTriggered) < ALERT_COOLDOWN_MS) {
    existing.count++;
    existing.lastTriggered = now;
    return;
  }

  const alert = {
    level,
    message,
    details,
    firstTriggered: existing ? existing.firstTriggered : new Date().toISOString(),
    lastTriggered: now,
    count: existing ? existing.count + 1 : 1,
  };

  activeAlerts.set(ruleId, alert);

  // Log to Winston
  const logEntry = { ruleId, level, ...details };
  if (level === ALERT_LEVELS.CRITICAL) {
    logger.error(`[ALERT:${level}] ${message}`, logEntry);
  } else if (level === ALERT_LEVELS.WARNING) {
    logger.warn(`[ALERT:${level}] ${message}`, logEntry);
  } else {
    logger.info(`[ALERT:${level}] ${message}`, logEntry);
  }

  // Add to alert log
  alertLog.push({
    timestamp: new Date().toISOString(),
    ruleId,
    level,
    message,
    details,
    action: 'triggered',
  });
  if (alertLog.length > MAX_ALERT_LOG) {
    alertLog.shift();
  }
}

function resolveAlert(ruleId) {
  if (activeAlerts.has(ruleId)) {
    const alert = activeAlerts.get(ruleId);

    logger.info(`[ALERT:RESOLVED] ${ruleId}`, {
      ruleId,
      duration: Date.now() - new Date(alert.firstTriggered).getTime(),
      triggerCount: alert.count,
    });

    alertLog.push({
      timestamp: new Date().toISOString(),
      ruleId,
      level: 'RESOLVED',
      message: `Alert ${ruleId} resolved`,
      details: { triggerCount: alert.count },
      action: 'resolved',
    });
    if (alertLog.length > MAX_ALERT_LOG) {
      alertLog.shift();
    }

    activeAlerts.delete(ruleId);
  }
}

module.exports = {
  evaluate,
  recordError,
  recordAuthFailure,
  getActiveAlerts,
  getAlertHistory,
  getThresholds,
  reset,
  ALERT_LEVELS,
};
