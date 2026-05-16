/**
 * @module organizationRoutes
 * @description REST API routes for organization management (multi-tenant SaaS).
 *
 * Routes:
 *   POST   /api/v1/organizations              - Create organization (onboarding)
 *   GET    /api/v1/organizations              - List organizations (super admin)
 *   GET    /api/v1/organizations/:id          - Get organization details
 *   PUT    /api/v1/organizations/:id          - Update organization
 *   DELETE /api/v1/organizations/:id          - Suspend organization
 *   POST   /api/v1/organizations/:id/reactivate - Reactivate organization
 *   GET    /api/v1/organizations/:id/usage    - Get usage stats
 *   GET    /api/v1/organizations/:id/statistics - Get statistics
 */

'use strict';

const organizationService = require('../services/organization.service');
const { extractTenantContext, verifyOrgAccess } = require('../middleware/tenancy.middleware');
const { requireRole, checkPermission } = require('../middleware/rbac.middleware');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseQuery(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

// ─── Route Handler ───────────────────────────────────────────────────────────

async function handleOrganizationRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return sendJSON(res, 200, {});
  }

  // Extract tenant context
  extractTenantContext(req, res, () => {});

  try {
    // POST /api/v1/organizations — Create (public for onboarding)
    if (path === '/api/v1/organizations' && method === 'POST') {
      const body = await parseBody(req);
      const org = await organizationService.createOrganization(body);
      return sendJSON(res, 201, { success: true, data: org });
    }

    // GET /api/v1/organizations — List all (super admin)
    if (path === '/api/v1/organizations' && method === 'GET') {
      if (!checkPermission('organizations.list')(req, res)) return;
      const query = parseQuery(req.url);
      const result = await organizationService.listOrganizations({
        page: parseInt(query.page) || 1,
        limit: parseInt(query.limit) || 20,
        type: query.type,
        status: query.status,
        search: query.search,
      });
      return sendJSON(res, 200, { success: true, ...result });
    }

    // Match /api/v1/organizations/:id/...
    const idMatch = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})(\/.*)?$/);
    if (idMatch) {
      const orgId = idMatch[1];
      const subPath = idMatch[2] || '';

      // Verify access (super admin or own org)
      if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
        return sendJSON(res, 403, { error: 'Forbidden', message: 'Access denied to this organization' });
      }

      // GET /api/v1/organizations/:id
      if (subPath === '' && method === 'GET') {
        const org = await organizationService.getOrganization(orgId);
        return sendJSON(res, 200, { success: true, data: org });
      }

      // PUT /api/v1/organizations/:id
      if (subPath === '' && method === 'PUT') {
        if (!checkPermission('organizations.update')(req, res)) return;
        const body = await parseBody(req);
        const org = await organizationService.updateOrganization(orgId, body);
        return sendJSON(res, 200, { success: true, data: org });
      }

      // DELETE /api/v1/organizations/:id — Suspend
      if (subPath === '' && method === 'DELETE') {
        if (!checkPermission('organizations.suspend')(req, res)) return;
        const body = await parseBody(req).catch(() => ({}));
        const org = await organizationService.suspendOrganization(orgId, body.reason);
        return sendJSON(res, 200, { success: true, data: org, message: 'Organization suspended' });
      }

      // POST /api/v1/organizations/:id/reactivate
      if (subPath === '/reactivate' && method === 'POST') {
        if (!checkPermission('organizations.suspend')(req, res)) return;
        const org = await organizationService.reactivateOrganization(orgId);
        return sendJSON(res, 200, { success: true, data: org, message: 'Organization reactivated' });
      }

      // GET /api/v1/organizations/:id/usage
      if (subPath === '/usage' && method === 'GET') {
        const query = parseQuery(req.url);
        const usage = await organizationService.getOrganizationUsage(
          orgId, parseInt(query.month), parseInt(query.year)
        );
        return sendJSON(res, 200, { success: true, data: usage });
      }

      // GET /api/v1/organizations/:id/statistics
      if (subPath === '/statistics' && method === 'GET') {
        const stats = await organizationService.getOrganizationStatistics(orgId);
        return sendJSON(res, 200, { success: true, data: stats });
      }
    }

    // Not matched
    return null;
  } catch (error) {
    logger.error('Organization route error', { error: error.message, path, method });
    return sendJSON(res, error.message.includes('not found') ? 404 : 400, {
      success: false,
      error: error.message,
    });
  }
}

module.exports = handleOrganizationRoutes;
