/**
 * @module tenancy.middleware
 * @description Multi-tenancy middleware for Horizon Medical SaaS platform.
 *
 * Extracts organization context from JWT tokens and injects tenant filtering
 * into all database queries to ensure data isolation between organizations.
 */

'use strict';

const logger = require('../utils/logger');
const { Organization } = require('../models/saas');

// ─── Roles that bypass tenant filtering (platform-level access) ─────────────
const SUPER_ADMIN_ROLES = ['super_admin'];

/**
 * Extract organization context from the request.
 * Populates req.organization and req.organizationId.
 */
function extractTenantContext(req, res, next) {
  try {
    // If auth is disabled (dev mode), skip tenant extraction
    if (process.env.AUTH_ENABLED === 'false') {
      req.organizationId = req.headers['x-organization-id'] || null;
      req.userRole = req.headers['x-user-role'] || 'super_admin';
      req.isSuperAdmin = SUPER_ADMIN_ROLES.includes(req.userRole);
      return next();
    }

    // Extract from JWT payload (set by auth middleware)
    if (req.user) {
      req.organizationId = req.user.organizationId || null;
      req.userRole = req.user.role || 'technician';
      req.userId = req.user.userId || req.user.sub || null;
      req.isSuperAdmin = SUPER_ADMIN_ROLES.includes(req.userRole);
    } else {
      // Fallback to headers for development/testing
      req.organizationId = req.headers['x-organization-id'] || null;
      req.userRole = req.headers['x-user-role'] || 'technician';
      req.isSuperAdmin = SUPER_ADMIN_ROLES.includes(req.userRole);
    }

    next();
  } catch (error) {
    logger.error('Tenant context extraction failed', { error: error.message });
    next();
  }
}

/**
 * Require tenant context — returns 403 if no organization context.
 * Super admins can access any org; others need a valid org.
 */
function requireTenantContext(req, res) {
  if (req.isSuperAdmin) return true;

  if (!req.organizationId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Forbidden',
      message: 'Organization context required. Please authenticate with a valid organization.',
    }));
    return false;
  }
  return true;
}

/**
 * Verify organization is active and not suspended.
 */
async function verifyOrganizationActive(req, res, next) {
  try {
    if (req.isSuperAdmin || !req.organizationId) {
      return next();
    }

    const org = await Organization.findById(req.organizationId).lean();
    if (!org) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Organization not found' }));
      return;
    }

    if (!org.isActive || org.subscriptionStatus === 'suspended') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Organization suspended',
        message: 'Your organization has been suspended. Please contact support.',
      }));
      return;
    }

    req.organization = org;
    next();
  } catch (error) {
    logger.error('Organization verification failed', { error: error.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * Build tenant-aware query filter.
 * Super admins get all data; others get only their org's data.
 */
function buildTenantFilter(req, baseFilter = {}) {
  if (req.isSuperAdmin && !req.query?.organizationId) {
    return baseFilter;
  }

  const orgId = req.query?.organizationId || req.organizationId;
  if (orgId) {
    return { ...baseFilter, organizationId: orgId };
  }

  return baseFilter;
}

/**
 * Inject organizationId into request body for create operations.
 */
function injectTenantId(req) {
  if (req.organizationId && req.body && typeof req.body === 'object') {
    req.body.organizationId = req.organizationId;
  }
}

/**
 * Verify user has access to the specified organization.
 * Super admins can access any org.
 */
function verifyOrgAccess(req, targetOrgId) {
  if (req.isSuperAdmin) return true;
  if (!req.organizationId) return false;
  return String(req.organizationId) === String(targetOrgId);
}

module.exports = {
  extractTenantContext,
  requireTenantContext,
  verifyOrganizationActive,
  buildTenantFilter,
  injectTenantId,
  verifyOrgAccess,
  SUPER_ADMIN_ROLES,
};
