/**
 * @module invitationRoutes
 * @description REST API routes for user invitations.
 *
 * Routes:
 *   POST   /api/v1/organizations/:id/invitations  - Invite user
 *   GET    /api/v1/invitations/:token              - Validate invitation
 *   POST   /api/v1/invitations/:token/accept       - Accept invitation
 */

'use strict';

const { Invitation, MedicalUser, Organization } = require('../models');
const { v4: uuidv4 } = require('uuid');
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

async function handleInvitationRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 200, {});

  extractTenantContext(req, res, () => {});

  try {
    // POST /api/v1/organizations/:id/invitations — Send invitation
    const orgMatch = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})\/invitations$/);
    if (orgMatch && method === 'POST') {
      if (!checkPermission('users.invite')(req, res)) return;
      const orgId = orgMatch[1];

      if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
        return sendJSON(res, 403, { error: 'Forbidden' });
      }

      const body = await parseBody(req);
      if (!body.email || !body.role) {
        return sendJSON(res, 400, { error: 'email and role are required' });
      }

      // Check if invitation already exists
      const existing = await Invitation.findOne({
        organizationId: orgId,
        email: body.email,
        status: 'pending',
      });
      if (existing) {
        return sendJSON(res, 409, { error: 'Invitation already pending for this email' });
      }

      const invitation = new Invitation({
        organizationId: orgId,
        email: body.email,
        role: body.role,
        invitedBy: req.userId || orgId,
        message: body.message,
      });

      await invitation.save();

      logger.info('Invitation sent', { orgId, email: body.email, role: body.role });
      return sendJSON(res, 201, { success: true, data: invitation });
    }

    // GET /api/v1/organizations/:id/invitations — List invitations
    const listMatch = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})\/invitations$/);
    if (listMatch && method === 'GET') {
      const orgId = listMatch[1];
      if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
        return sendJSON(res, 403, { error: 'Forbidden' });
      }
      const invitations = await Invitation.find({ organizationId: orgId }).sort({ createdAt: -1 }).lean();
      return sendJSON(res, 200, { success: true, data: invitations });
    }

    // GET /api/v1/invitations/:token — Validate
    const tokenMatch = path.match(/^\/api\/v1\/invitations\/([a-f0-9]{64})$/);
    if (tokenMatch && method === 'GET') {
      const token = tokenMatch[1];
      const invitation = await Invitation.findOne({ token })
        .populate({ path: 'organizationId', select: 'name type' })
        .lean();

      if (!invitation) {
        return sendJSON(res, 404, { error: 'Invitation not found' });
      }

      if (invitation.status !== 'pending') {
        return sendJSON(res, 400, { error: `Invitation is ${invitation.status}` });
      }

      if (new Date() > invitation.expiresAt) {
        return sendJSON(res, 400, { error: 'Invitation has expired' });
      }

      return sendJSON(res, 200, { success: true, data: invitation });
    }

    // POST /api/v1/invitations/:token/accept — Accept
    const acceptMatch = path.match(/^\/api\/v1\/invitations\/([a-f0-9]{64})\/accept$/);
    if (acceptMatch && method === 'POST') {
      const token = acceptMatch[1];
      const invitation = await Invitation.findOne({ token });

      if (!invitation || invitation.status !== 'pending') {
        return sendJSON(res, 400, { error: 'Invalid or expired invitation' });
      }

      if (new Date() > invitation.expiresAt) {
        invitation.status = 'expired';
        await invitation.save();
        return sendJSON(res, 400, { error: 'Invitation has expired' });
      }

      const body = await parseBody(req);

      // Create user account
      const user = new MedicalUser({
        userId: uuidv4(),
        organizationId: invitation.organizationId,
        email: invitation.email,
        passwordHash: MedicalUser.hashPassword(body.password || 'changeme123'),
        firstName: body.firstName || '',
        lastName: body.lastName || '',
        role: invitation.role,
        active: true,
      });

      await user.save();

      // Mark invitation as accepted
      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      await invitation.save();

      logger.info('Invitation accepted', { email: invitation.email, orgId: invitation.organizationId });
      return sendJSON(res, 201, { success: true, data: { user: user.toSafeJSON(), invitation } });
    }

    return null;
  } catch (error) {
    logger.error('Invitation route error', { error: error.message, path });
    return sendJSON(res, 400, { success: false, error: error.message });
  }
}

module.exports = handleInvitationRoutes;
