/**
 * @module rpmRoutes
 * @description REST API routes for Remote Patient Monitoring (RPM).
 *
 * Routes:
 *   GET    /api/v1/organizations/:id/rpm/patients              - List RPM patients
 *   POST   /api/v1/organizations/:id/rpm/patients              - Enroll patient in RPM
 *   GET    /api/v1/organizations/:id/rpm/patients/:patientId   - Get RPM enrollment detail
 *   PUT    /api/v1/organizations/:id/rpm/patients/:patientId   - Update RPM enrollment
 *   DELETE /api/v1/organizations/:id/rpm/patients/:patientId   - Remove from RPM
 *   GET    /api/v1/organizations/:id/rpm/analytics             - RPM analytics
 */

'use strict';

const { RPMEnrollment, Patient } = require('../models');
const usageTrackingService = require('../services/usage-tracking.service');
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

function parseQuery(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

async function handleRPMRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 200, {});

  extractTenantContext(req, res, () => {});

  try {
    // Match /api/v1/organizations/:id/rpm/...
    const match = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})\/rpm(\/.*)?$/);
    if (!match) return null;

    const orgId = match[1];
    const subPath = match[2] || '';

    if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }

    // GET /rpm/patients — List enrolled patients
    if (subPath === '/patients' && method === 'GET') {
      if (!checkPermission('rpm.view')(req, res)) return;
      const query = parseQuery(req.url);
      const filter = { organizationId: orgId };
      if (query.status) filter.status = query.status;

      const page = parseInt(query.page) || 1;
      const limit = parseInt(query.limit) || 20;
      const skip = (page - 1) * limit;

      const [enrollments, total] = await Promise.all([
        RPMEnrollment.find(filter).sort({ enrolledAt: -1 }).skip(skip).limit(limit).lean(),
        RPMEnrollment.countDocuments(filter),
      ]);

      // Enrich with patient data
      const patientIds = enrollments.map(e => e.patientId);
      const patients = await Patient.find({ patientId: { $in: patientIds } }).lean();
      const patientMap = {};
      patients.forEach(p => { patientMap[p.patientId] = p; });

      const enriched = enrollments.map(e => ({
        ...e,
        patient: patientMap[e.patientId] || null,
      }));

      return sendJSON(res, 200, {
        success: true,
        data: enriched,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    }

    // POST /rpm/patients — Enroll patient
    if (subPath === '/patients' && method === 'POST') {
      if (!checkPermission('rpm.manage')(req, res)) return;
      const body = await parseBody(req);

      if (!body.patientId) {
        return sendJSON(res, 400, { error: 'patientId is required' });
      }

      const existing = await RPMEnrollment.findOne({
        organizationId: orgId,
        patientId: body.patientId,
        status: 'active',
      });
      if (existing) {
        return sendJSON(res, 409, { error: 'Patient already enrolled in RPM' });
      }

      const enrollment = new RPMEnrollment({
        organizationId: orgId,
        patientId: body.patientId,
        monitoringType: body.monitoringType || 'continuous',
        alertThresholds: body.alertThresholds,
        assignedDeviceId: body.deviceId,
        assignedPhysicianId: body.physicianId,
        pricePerMonth: body.pricePerMonth || 25,
        diagnosis: body.diagnosis,
        notes: body.notes,
      });

      await enrollment.save();

      // Track in usage
      await usageTrackingService.trackRPMPatient(orgId, body.patientId);

      logger.info('Patient enrolled in RPM', { orgId, patientId: body.patientId });
      return sendJSON(res, 201, { success: true, data: enrollment });
    }

    // Match /rpm/patients/:patientId
    const patientMatch = subPath.match(/^\/patients\/([^/]+)$/);
    if (patientMatch) {
      const patientId = patientMatch[1];

      // GET /rpm/patients/:patientId
      if (method === 'GET') {
        if (!checkPermission('rpm.view')(req, res)) return;
        const enrollment = await RPMEnrollment.findOne({
          organizationId: orgId,
          patientId,
        }).lean();
        if (!enrollment) return sendJSON(res, 404, { error: 'RPM enrollment not found' });

        const patient = await Patient.findOne({ patientId }).lean();
        return sendJSON(res, 200, { success: true, data: { ...enrollment, patient } });
      }

      // PUT /rpm/patients/:patientId — Update
      if (method === 'PUT') {
        if (!checkPermission('rpm.manage')(req, res)) return;
        const body = await parseBody(req);
        const enrollment = await RPMEnrollment.findOneAndUpdate(
          { organizationId: orgId, patientId },
          { $set: body },
          { new: true }
        );
        if (!enrollment) return sendJSON(res, 404, { error: 'RPM enrollment not found' });
        return sendJSON(res, 200, { success: true, data: enrollment });
      }

      // DELETE /rpm/patients/:patientId — Remove from RPM
      if (method === 'DELETE') {
        if (!checkPermission('rpm.manage')(req, res)) return;
        const enrollment = await RPMEnrollment.findOneAndUpdate(
          { organizationId: orgId, patientId, status: 'active' },
          { status: 'completed', completedAt: new Date() },
          { new: true }
        );
        if (!enrollment) return sendJSON(res, 404, { error: 'Active RPM enrollment not found' });
        logger.info('Patient removed from RPM', { orgId, patientId });
        return sendJSON(res, 200, { success: true, data: enrollment, message: 'Patient removed from RPM' });
      }
    }

    // GET /rpm/analytics
    if (subPath === '/analytics' && method === 'GET') {
      if (!checkPermission('rpm.view')(req, res)) return;
      const [activeCount, totalCount, enrollments] = await Promise.all([
        RPMEnrollment.countDocuments({ organizationId: orgId, status: 'active' }),
        RPMEnrollment.countDocuments({ organizationId: orgId }),
        RPMEnrollment.find({ organizationId: orgId, status: 'active' }).lean(),
      ]);

      const monthlyRevenue = enrollments.reduce((sum, e) => sum + (e.pricePerMonth || 0), 0);

      return sendJSON(res, 200, {
        success: true,
        data: {
          active: activeCount,
          total: totalCount,
          completed: totalCount - activeCount,
          monthlyRevenue,
          monitoringTypes: {
            continuous: enrollments.filter(e => e.monitoringType === 'continuous').length,
            event_based: enrollments.filter(e => e.monitoringType === 'event_based').length,
            scheduled: enrollments.filter(e => e.monitoringType === 'scheduled').length,
          },
        },
      });
    }

    return null;
  } catch (error) {
    logger.error('RPM route error', { error: error.message, path });
    return sendJSON(res, 400, { success: false, error: error.message });
  }
}

module.exports = handleRPMRoutes;
