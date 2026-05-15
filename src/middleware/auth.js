/**
 * @module auth
 * @description JWT authentication middleware for WebSocket connections.
 *
 * Clients must provide a valid JWT token either:
 *   1. As a query parameter: ws://host:port?token=<JWT>
 *   2. In the Sec-WebSocket-Protocol header (for browser clients)
 *
 * Tokens are verified against JWT_SECRET from environment variables.
 * Failed authentication attempts are logged as security events.
 */

const jwt = require('jsonwebtoken');
const url = require('url');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ALGORITHM = process.env.JWT_ALGORITHM || 'HS256';

if (!JWT_SECRET) {
  logger.error('CRITICAL: JWT_SECRET environment variable is not set. Authentication will reject all connections.');
}

/**
 * Extract JWT token from the WebSocket upgrade request.
 * Supports: query param ?token=, Authorization header, Sec-WebSocket-Protocol header.
 * @param {import('http').IncomingMessage} request - The HTTP upgrade request
 * @returns {string|null} The extracted token or null
 */
function extractToken(request) {
  // 1. Query parameter (?token=...)
  const parsed = url.parse(request.url, true);
  if (parsed.query && parsed.query.token) {
    return parsed.query.token;
  }

  // 2. Authorization header (Bearer <token>)
  const authHeader = request.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 3. Sec-WebSocket-Protocol header (for browser clients that can't set custom headers)
  const protocol = request.headers['sec-websocket-protocol'];
  if (protocol) {
    // Format: "jwt,<token>" or just the token
    const parts = protocol.split(',').map(p => p.trim());
    if (parts.length >= 2 && parts[0].toLowerCase() === 'jwt') {
      return parts[1];
    }
  }

  return null;
}

/**
 * Get client IP address from the request, respecting X-Forwarded-For (Nginx proxy).
 * @param {import('http').IncomingMessage} request
 * @returns {string}
 */
function getClientIP(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

/**
 * Authenticate a WebSocket upgrade request using JWT.
 * @param {import('http').IncomingMessage} request - The HTTP upgrade request
 * @returns {{ authenticated: boolean, user: object|null, error: string|null }}
 */
function authenticateConnection(request) {
  const clientIP = getClientIP(request);

  if (!JWT_SECRET) {
    logger.security('AUTH_CONFIG_ERROR', { ip: clientIP, reason: 'JWT_SECRET not configured' });
    return { authenticated: false, user: null, error: 'Server authentication not configured' };
  }

  const token = extractToken(request);

  if (!token) {
    logger.security('AUTH_NO_TOKEN', { ip: clientIP, url: request.url });
    return { authenticated: false, user: null, error: 'No authentication token provided' };
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      maxAge: process.env.JWT_MAX_AGE || '24h',
    });

    // Validate required claims for medical context
    if (!decoded.sub && !decoded.userId && !decoded.deviceId) {
      logger.security('AUTH_MISSING_CLAIMS', { ip: clientIP, claims: Object.keys(decoded) });
      return { authenticated: false, user: null, error: 'Token missing required identity claims (sub, userId, or deviceId)' };
    }

    const user = {
      id: decoded.sub || decoded.userId || decoded.deviceId,
      role: decoded.role || 'device',
      deviceId: decoded.deviceId || null,
      patientId: decoded.patientId || null,
      permissions: decoded.permissions || [],
      tokenIssuedAt: decoded.iat,
      tokenExpires: decoded.exp,
    };

    logger.info('Client authenticated', { ip: clientIP, userId: user.id, role: user.role });
    return { authenticated: true, user, error: null };

  } catch (err) {
    let reason = 'Token verification failed';

    if (err.name === 'TokenExpiredError') {
      reason = 'Token expired';
    } else if (err.name === 'JsonWebTokenError') {
      reason = `Invalid token: ${err.message}`;
    } else if (err.name === 'NotBeforeError') {
      reason = 'Token not yet active';
    }

    logger.security('AUTH_FAILED', { ip: clientIP, reason, errorName: err.name });
    return { authenticated: false, user: null, error: reason };
  }
}

/**
 * Generate a JWT token for a device or user (utility for testing/admin).
 * @param {object} payload - Token payload { sub, role, deviceId, patientId, permissions }
 * @param {string} [expiresIn='24h'] - Token expiration time
 * @returns {string} Signed JWT token
 */
function generateToken(payload, expiresIn = '24h') {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn,
  });
}

module.exports = {
  authenticateConnection,
  generateToken,
  extractToken,
  getClientIP,
};
