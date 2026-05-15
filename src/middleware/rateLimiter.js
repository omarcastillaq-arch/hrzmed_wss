/**
 * @module rateLimiter
 * @description Simple in-memory rate limiter for WebSocket connections.
 * Prevents abuse by limiting connection attempts and message rates per IP.
 */

const logger = require('../utils/logger');

class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.maxConnectionsPerIP - Max concurrent connections per IP
   * @param {number} options.maxMessagesPerSecond - Max messages per second per connection
   * @param {number} options.maxAuthFailuresPerIP - Max auth failures before temporary ban
   * @param {number} options.banDurationMs - Ban duration in milliseconds
   */
  constructor(options = {}) {
    this.maxConnectionsPerIP = options.maxConnectionsPerIP || 10;
    this.maxMessagesPerSecond = options.maxMessagesPerSecond || 50;
    this.maxAuthFailuresPerIP = options.maxAuthFailuresPerIP || 5;
    this.banDurationMs = options.banDurationMs || 15 * 60 * 1000; // 15 minutes

    /** @type {Map<string, number>} IP -> active connection count */
    this.connectionCounts = new Map();

    /** @type {Map<string, { count: number, resetAt: number }>} connectionId -> message rate */
    this.messageRates = new Map();

    /** @type {Map<string, { failures: number, bannedUntil: number }>} IP -> auth failure tracking */
    this.authFailures = new Map();

    // Cleanup stale entries every 60 seconds
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
  }

  /**
   * Check if an IP is currently banned.
   * @param {string} ip
   * @returns {boolean}
   */
  isBanned(ip) {
    const record = this.authFailures.get(ip);
    if (!record) return false;
    if (record.bannedUntil && Date.now() < record.bannedUntil) {
      return true;
    }
    if (record.bannedUntil && Date.now() >= record.bannedUntil) {
      this.authFailures.delete(ip);
      return false;
    }
    return false;
  }

  /**
   * Record an auth failure for an IP.
   * @param {string} ip
   */
  recordAuthFailure(ip) {
    const record = this.authFailures.get(ip) || { failures: 0, bannedUntil: null };
    record.failures++;

    if (record.failures >= this.maxAuthFailuresPerIP) {
      record.bannedUntil = Date.now() + this.banDurationMs;
      logger.security('IP_BANNED', {
        ip,
        failures: record.failures,
        banDurationMin: this.banDurationMs / 60000,
      });
    }

    this.authFailures.set(ip, record);
  }

  /**
   * Check if a new connection from this IP is allowed.
   * @param {string} ip
   * @returns {boolean}
   */
  allowConnection(ip) {
    if (this.isBanned(ip)) return false;
    const current = this.connectionCounts.get(ip) || 0;
    return current < this.maxConnectionsPerIP;
  }

  /**
   * Register a new connection from an IP.
   * @param {string} ip
   */
  addConnection(ip) {
    const current = this.connectionCounts.get(ip) || 0;
    this.connectionCounts.set(ip, current + 1);
  }

  /**
   * Unregister a connection from an IP.
   * @param {string} ip
   */
  removeConnection(ip) {
    const current = this.connectionCounts.get(ip) || 0;
    if (current <= 1) {
      this.connectionCounts.delete(ip);
    } else {
      this.connectionCounts.set(ip, current - 1);
    }
  }

  /**
   * Check if a message from a connection is within rate limits.
   * @param {string} connectionId
   * @returns {boolean}
   */
  allowMessage(connectionId) {
    const now = Date.now();
    const record = this.messageRates.get(connectionId);

    if (!record || now >= record.resetAt) {
      this.messageRates.set(connectionId, { count: 1, resetAt: now + 1000 });
      return true;
    }

    record.count++;
    if (record.count > this.maxMessagesPerSecond) {
      return false;
    }
    return true;
  }

  /**
   * Remove message rate tracking for a connection.
   * @param {string} connectionId
   */
  removeMessageTracking(connectionId) {
    this.messageRates.delete(connectionId);
  }

  /** Clean up stale rate limit entries */
  _cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.authFailures) {
      if (record.bannedUntil && now >= record.bannedUntil) {
        this.authFailures.delete(ip);
      }
    }
    for (const [id, record] of this.messageRates) {
      if (now >= record.resetAt + 5000) {
        this.messageRates.delete(id);
      }
    }
  }

  /** Cleanup on shutdown */
  destroy() {
    clearInterval(this._cleanupInterval);
  }
}

module.exports = RateLimiter;
