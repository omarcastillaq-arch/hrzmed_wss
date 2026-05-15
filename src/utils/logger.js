/**
 * @module logger
 * @description Centralized logging with Winston for the Horizon Medical WebSocket server.
 * Provides structured logging with security event tracking for HIPAA-adjacent compliance.
 */

const winston = require('winston');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Custom format for security events
const securityFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level.toUpperCase()}]${metaStr} ${message}`;
});

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    securityFormat
  ),
  defaultMeta: { service: 'hrzmed-wss' },
  transports: [
    new winston.transports.Console({
      colorize: NODE_ENV === 'development',
    }),
  ],
});

// Add file transport in production
if (NODE_ENV === 'production') {
  logger.add(new winston.transports.File({
    filename: '/var/log/hrzmed/error.log',
    level: 'error',
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 5,
  }));
  logger.add(new winston.transports.File({
    filename: '/var/log/hrzmed/security.log',
    level: 'warn',
    maxsize: 5 * 1024 * 1024,
    maxFiles: 10,
  }));
}

/**
 * Log a security-relevant event (auth failures, invalid data, rate limits, etc.)
 * @param {string} event - Event type identifier
 * @param {object} details - Event details (IP, userId, reason, etc.)
 */
logger.security = function (event, details = {}) {
  this.warn(`[SECURITY] ${event}`, { security: true, event, ...details });
};

/**
 * Log a medical data event (validation failures, anomalies)
 * @param {string} event - Event type identifier
 * @param {object} details - Event details
 */
logger.medical = function (event, details = {}) {
  this.info(`[MEDICAL] ${event}`, { medical: true, event, ...details });
};

module.exports = logger;
