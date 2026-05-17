/**
 * @module subscriptionRoutes
 * @description REST API routes for subscription and plan management.
 *
 * Routes:
 *   GET    /api/v1/plans                                    - List available plans
 *   GET    /api/v1/organizations/:id/subscription           - Current subscription
 *   POST   /api/v1/organizations/:id/subscription           - Assign plan
 *   PUT    /api/v1/organizations/:id/subscription/upgrade   - Upgrade plan
 *   PUT    /api/v1/organizations/:id/subscription/downgrade - Downgrade plan
 *   DELETE /api/v1/organizations/:id/subscription           - Cancel subscription
 *   GET    /api/v1/organizations/:id/subscription/limits    - Check limits
 */

'use strict';

const subscriptionService = require('../services/subscription.service');
const { extractTenantContext, verifyOrgAccess } = require('../middleware/tenancy.middleware');
const { checkPermission } = require('../middleware/rbac.middleware');
const logger = require('../utils/logger');

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

async function handleSubscriptionRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 200, {});

  extractTenantContext(req, res, () => {});

  try {
    // GET /api/v1/plans — Public
    if (path === '/api/v1/plans' && method === 'GET') {
      const plans = await subscriptionService.listPlans();
      return sendJSON(res, 200, { success: true, data: plans });
    }

    // Match /api/v1/organizations/:id/subscription...
    const match = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})\/subscription(\/.*)?$/);
    if (match) {
      const orgId = match[1];
      const subPath = match[2] || '';

      if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
        return sendJSON(res, 403, { error: 'Forbidden' });
      }

      // GET /subscription
      if (subPath === '' && method === 'GET') {
        const sub = await subscriptionService.getCurrentSubscription(orgId);
        return sendJSON(res, 200, { success: true, data: sub });
      }

      // POST /subscription — Assign plan
      if (subPath === '' && method === 'POST') {
        if (!checkPermission('subscriptions.manage')(req, res)) return;
        const body = await parseBody(req);
        const sub = await subscriptionService.assignPlan(orgId, body.planId, body);
        return sendJSON(res, 201, { success: true, data: sub });
      }

      // PUT /subscription/upgrade
      if (subPath === '/upgrade' && method === 'PUT') {
        if (!checkPermission('subscriptions.manage')(req, res)) return;
        const body = await parseBody(req);
        const sub = await subscriptionService.upgradePlan(orgId, body.planId);
        return sendJSON(res, 200, { success: true, data: sub });
      }

      // PUT /subscription/downgrade
      if (subPath === '/downgrade' && method === 'PUT') {
        if (!checkPermission('subscriptions.manage')(req, res)) return;
        const body = await parseBody(req);
        const sub = await subscriptionService.downgradePlan(orgId, body.planId);
        return sendJSON(res, 200, { success: true, data: sub });
      }

      // DELETE /subscription — Cancel
      if (subPath === '' && method === 'DELETE') {
        if (!checkPermission('subscriptions.manage')(req, res)) return;
        const sub = await subscriptionService.cancelSubscription(orgId);
        return sendJSON(res, 200, { success: true, data: sub, message: 'Subscription cancelled' });
      }

      // GET /subscription/limits
      if (subPath === '/limits' && method === 'GET') {
        const limits = await subscriptionService.checkLimits(orgId);
        return sendJSON(res, 200, { success: true, data: limits });
      }
    }

    return null;
  } catch (error) {
    logger.error('Subscription route error', { error: error.message, path });
    return sendJSON(res, error.message.includes('not found') ? 404 : 400, {
      success: false, error: error.message,
    });
  }
}

module.exports = handleSubscriptionRoutes;
