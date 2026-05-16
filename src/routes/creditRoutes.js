/**
 * @module creditRoutes
 * @description REST API routes for credit management (pay-per-study).
 *
 * Routes:
 *   GET    /api/v1/organizations/:id/credits           - Get balance
 *   POST   /api/v1/organizations/:id/credits/purchase  - Purchase credits
 *   POST   /api/v1/organizations/:id/credits/refund    - Refund credits
 *   GET    /api/v1/organizations/:id/credits/history    - Transaction history
 */

'use strict';

const creditService = require('../services/credit.service');
const { extractTenantContext, verifyOrgAccess } = require('../middleware/tenancy.middleware');
const { checkPermission } = require('../middleware/rbac.middleware');
const logger = require('../utils/logger');

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Organization-Id, X-User-Role',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function parseQuery(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

async function handleCreditRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 200, {});

  extractTenantContext(req, res, () => {});

  try {
    const match = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})\/credits(\/.*)?$/);
    if (!match) return null;

    const orgId = match[1];
    const subPath = match[2] || '';

    if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }

    // GET /credits — Balance
    if (subPath === '' && method === 'GET') {
      if (!checkPermission('credits.view')(req, res)) return;
      const balance = await creditService.getBalance(orgId);
      return sendJSON(res, 200, { success: true, data: balance });
    }

    // POST /credits/purchase
    if (subPath === '/purchase' && method === 'POST') {
      if (!checkPermission('credits.purchase')(req, res)) return;
      const body = await parseBody(req);
      const result = await creditService.purchaseCredits(
        orgId, body.amount, body.pricePerCredit || 0, body.currency, req.userId
      );
      return sendJSON(res, 201, { success: true, data: result });
    }

    // POST /credits/refund
    if (subPath === '/refund' && method === 'POST') {
      if (!checkPermission('credits.purchase')(req, res)) return;
      const body = await parseBody(req);
      const result = await creditService.refundCredits(orgId, body.amount, body.reason, req.userId);
      return sendJSON(res, 200, { success: true, data: result });
    }

    // GET /credits/history
    if (subPath === '/history' && method === 'GET') {
      if (!checkPermission('credits.view')(req, res)) return;
      const query = parseQuery(req.url);
      const result = await creditService.getHistory(orgId, {
        page: parseInt(query.page) || 1,
        limit: parseInt(query.limit) || 20,
        type: query.type,
      });
      return sendJSON(res, 200, { success: true, ...result });
    }

    return null;
  } catch (error) {
    logger.error('Credit route error', { error: error.message, path });
    return sendJSON(res, 400, { success: false, error: error.message });
  }
}

module.exports = handleCreditRoutes;
