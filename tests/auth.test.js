/**
 * Tests for JWT authentication middleware
 * Run with: node --test tests/auth.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Set JWT_SECRET before requiring auth module
const TEST_SECRET = 'test-secret-for-auth-tests-minimum-32-chars';
process.env.JWT_SECRET = TEST_SECRET;

const { authenticateConnection, generateToken, extractToken } = require('../src/middleware/auth');

function mockRequest(urlPath, headers = {}) {
  return {
    url: urlPath || '/',
    headers: headers,
    socket: { remoteAddress: '127.0.0.1' },
  };
}

describe('extractToken', () => {
  it('should extract token from query parameter', () => {
    const req = mockRequest('/?token=abc123');
    assert.equal(extractToken(req), 'abc123');
  });

  it('should extract token from Authorization header', () => {
    const req = mockRequest('/', { authorization: 'Bearer my-token' });
    assert.equal(extractToken(req), 'my-token');
  });

  it('should extract token from Sec-WebSocket-Protocol header', () => {
    const req = mockRequest('/', { 'sec-websocket-protocol': 'jwt, my-token' });
    assert.equal(extractToken(req), 'my-token');
  });

  it('should return null when no token present', () => {
    const req = mockRequest('/');
    assert.equal(extractToken(req), null);
  });
});

describe('authenticateConnection', () => {
  it('should authenticate with valid token', () => {
    const token = jwt.sign({ sub: 'device-001', role: 'device' }, TEST_SECRET, { expiresIn: '1h' });
    const req = mockRequest(`/?token=${token}`);
    const result = authenticateConnection(req);
    assert.equal(result.authenticated, true);
    assert.equal(result.user.id, 'device-001');
    assert.equal(result.user.role, 'device');
  });

  it('should reject expired tokens', () => {
    const token = jwt.sign({ sub: 'device-001' }, TEST_SECRET, { expiresIn: '-1s' });
    const req = mockRequest(`/?token=${token}`);
    const result = authenticateConnection(req);
    assert.equal(result.authenticated, false);
    assert.ok(result.error.includes('expired') || result.error.includes('maxAge'));
  });

  it('should reject tokens with wrong secret', () => {
    const token = jwt.sign({ sub: 'device-001' }, 'wrong-secret');
    const req = mockRequest(`/?token=${token}`);
    const result = authenticateConnection(req);
    assert.equal(result.authenticated, false);
    assert.ok(result.error.includes('Invalid token'));
  });

  it('should reject tokens without identity claims', () => {
    const token = jwt.sign({ foo: 'bar' }, TEST_SECRET, { expiresIn: '1h' });
    const req = mockRequest(`/?token=${token}`);
    const result = authenticateConnection(req);
    assert.equal(result.authenticated, false);
    assert.ok(result.error.includes('missing required identity'));
  });

  it('should reject when no token provided', () => {
    const req = mockRequest('/');
    const result = authenticateConnection(req);
    assert.equal(result.authenticated, false);
    assert.ok(result.error.includes('No authentication token'));
  });

  it('should accept token with deviceId claim', () => {
    const token = jwt.sign({ deviceId: 'holter-001' }, TEST_SECRET, { expiresIn: '1h' });
    const req = mockRequest(`/?token=${token}`);
    const result = authenticateConnection(req);
    assert.equal(result.authenticated, true);
    assert.equal(result.user.id, 'holter-001');
  });
});

describe('generateToken', () => {
  it('should generate a valid token', () => {
    const token = generateToken({ sub: 'test', role: 'device' });
    const decoded = jwt.verify(token, TEST_SECRET);
    assert.equal(decoded.sub, 'test');
    assert.equal(decoded.role, 'device');
  });

  it('should respect custom expiration', () => {
    const token = generateToken({ sub: 'test' }, '30m');
    const decoded = jwt.verify(token, TEST_SECRET);
    assert.ok(decoded.exp - decoded.iat <= 1800 + 5); // ~30 minutes
  });
});
