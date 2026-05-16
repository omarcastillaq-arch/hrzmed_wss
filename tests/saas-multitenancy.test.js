/**
 * @module saas-multitenancy.test
 * @description Tests for SaaS multi-tenancy: models, middleware, RBAC, services.
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── Test: Tenancy Middleware ────────────────────────────────────────────────

describe('Tenancy Middleware', () => {
  const {
    extractTenantContext,
    buildTenantFilter,
    verifyOrgAccess,
    SUPER_ADMIN_ROLES,
  } = require('../src/middleware/tenancy.middleware');

  it('should extract tenant context from headers in dev mode', () => {
    const req = {
      headers: {
        'x-organization-id': '507f1f77bcf86cd799439011',
        'x-user-role': 'clinic_admin',
      },
    };
    const res = {};
    const originalEnv = process.env.AUTH_ENABLED;
    process.env.AUTH_ENABLED = 'false';

    extractTenantContext(req, res, () => {});

    assert.equal(req.organizationId, '507f1f77bcf86cd799439011');
    assert.equal(req.userRole, 'clinic_admin');
    assert.equal(req.isSuperAdmin, false);

    process.env.AUTH_ENABLED = originalEnv;
  });

  it('should mark super_admin correctly', () => {
    const req = {
      headers: { 'x-user-role': 'super_admin' },
    };
    const res = {};
    const originalEnv = process.env.AUTH_ENABLED;
    process.env.AUTH_ENABLED = 'false';

    extractTenantContext(req, res, () => {});

    assert.equal(req.isSuperAdmin, true);
    process.env.AUTH_ENABLED = originalEnv;
  });

  it('should build tenant filter for non-super-admin', () => {
    const req = {
      organizationId: '507f1f77bcf86cd799439011',
      isSuperAdmin: false,
    };
    const filter = buildTenantFilter(req, { active: true });
    assert.deepEqual(filter, {
      active: true,
      organizationId: '507f1f77bcf86cd799439011',
    });
  });

  it('should not add org filter for super admin', () => {
    const req = {
      organizationId: '507f1f77bcf86cd799439011',
      isSuperAdmin: true,
    };
    const filter = buildTenantFilter(req, { active: true });
    assert.deepEqual(filter, { active: true });
  });

  it('should verify org access correctly', () => {
    const req = { isSuperAdmin: false, organizationId: '507f1f77bcf86cd799439011' };
    assert.equal(verifyOrgAccess(req, '507f1f77bcf86cd799439011'), true);
    assert.equal(verifyOrgAccess(req, '507f1f77bcf86cd799439022'), false);
  });

  it('should allow super admin to access any org', () => {
    const req = { isSuperAdmin: true, organizationId: null };
    assert.equal(verifyOrgAccess(req, '507f1f77bcf86cd799439022'), true);
  });

  it('should define super admin roles', () => {
    assert.ok(SUPER_ADMIN_ROLES.includes('super_admin'));
  });
});

// ─── Test: RBAC Middleware ───────────────────────────────────────────────────

describe('RBAC Middleware', () => {
  const {
    ROLES,
    ROLE_HIERARCHY,
    PERMISSIONS,
    hasPermission,
    isRoleAtLeast,
    requireRole,
    checkPermission,
    getRolePermissions,
  } = require('../src/middleware/rbac.middleware');

  it('should define all roles', () => {
    assert.ok(ROLES.SUPER_ADMIN);
    assert.ok(ROLES.CLINIC_ADMIN);
    assert.ok(ROLES.DOCTOR);
    assert.ok(ROLES.CARDIOLOGIST);
    assert.ok(ROLES.TECHNICIAN);
    assert.ok(ROLES.PATIENT_B2C);
  });

  it('should have correct role hierarchy', () => {
    assert.ok(ROLE_HIERARCHY[ROLES.SUPER_ADMIN] > ROLE_HIERARCHY[ROLES.CLINIC_ADMIN]);
    assert.ok(ROLE_HIERARCHY[ROLES.CLINIC_ADMIN] > ROLE_HIERARCHY[ROLES.DOCTOR]);
    assert.ok(ROLE_HIERARCHY[ROLES.DOCTOR] > ROLE_HIERARCHY[ROLES.TECHNICIAN]);
    assert.ok(ROLE_HIERARCHY[ROLES.TECHNICIAN] > ROLE_HIERARCHY[ROLES.PATIENT_B2C]);
  });

  it('should check hasPermission correctly', () => {
    assert.equal(hasPermission('super_admin', 'organizations.create'), true);
    assert.equal(hasPermission('technician', 'organizations.create'), false);
    assert.equal(hasPermission('doctor', 'patients.create'), true);
    assert.equal(hasPermission('patient_b2c', 'patients.create'), false);
    assert.equal(hasPermission('patient_b2c', 'patients.read'), true);
  });

  it('should check isRoleAtLeast correctly', () => {
    assert.equal(isRoleAtLeast('super_admin', 'clinic_admin'), true);
    assert.equal(isRoleAtLeast('technician', 'clinic_admin'), false);
    assert.equal(isRoleAtLeast('doctor', 'doctor'), true);
  });

  it('should requireRole return false for unauthorized', () => {
    let statusCode, responseBody;
    const res = {
      writeHead: (code) => { statusCode = code; },
      end: (body) => { responseBody = body; },
    };
    const req = { userRole: 'technician' };
    const check = requireRole(['clinic_admin', 'super_admin']);
    const result = check(req, res);

    assert.equal(result, false);
    assert.equal(statusCode, 403);
  });

  it('should requireRole allow super admin always', () => {
    const res = {};
    const req = { userRole: 'super_admin' };
    const check = requireRole(['clinic_admin']);
    const result = check(req, res);
    assert.equal(result, true);
  });

  it('should checkPermission deny unauthorized', () => {
    let statusCode;
    const res = {
      writeHead: (code) => { statusCode = code; },
      end: () => {},
    };
    const req = { userRole: 'patient_b2c' };
    const check = checkPermission('organizations.create');
    const result = check(req, res);

    assert.equal(result, false);
    assert.equal(statusCode, 403);
  });

  it('should getRolePermissions return correct permissions', () => {
    const perms = getRolePermissions('super_admin');
    assert.ok(perms.length > 10);
    assert.ok(perms.includes('organizations.create'));
    assert.ok(perms.includes('system.admin'));

    const patientPerms = getRolePermissions('patient_b2c');
    assert.ok(patientPerms.includes('patients.read'));
    assert.ok(!patientPerms.includes('organizations.create'));
  });
});

// ─── Test: Model Schema Validation ──────────────────────────────────────────

describe('SaaS Model Schemas', () => {
  it('should load all SaaS models without errors', () => {
    const models = require('../src/models/saas');
    assert.ok(models.Organization);
    assert.ok(models.SubscriptionPlan);
    assert.ok(models.Subscription);
    assert.ok(models.Credit);
    assert.ok(models.UsageTracking);
    assert.ok(models.Invoice);
    assert.ok(models.Invitation);
    assert.ok(models.RPMEnrollment);
  });

  it('should have organizationId in modified models', () => {
    const Patient = require('../src/models/Patient');
    const MedicalUser = require('../src/models/MedicalUser');
    const DeviceAssignment = require('../src/models/DeviceAssignment');
    const ECGSession = require('../src/models/ECGSession');

    assert.ok(Patient.schema.paths.organizationId, 'Patient should have organizationId');
    assert.ok(MedicalUser.schema.paths.organizationId, 'MedicalUser should have organizationId');
    assert.ok(DeviceAssignment.schema.paths.organizationId, 'DeviceAssignment should have organizationId');
    assert.ok(ECGSession.schema.paths.organizationId, 'ECGSession should have organizationId');
  });

  it('should have expanded role enum for MedicalUser', () => {
    const MedicalUser = require('../src/models/MedicalUser');
    const roleEnum = MedicalUser.schema.paths.role.enumValues;
    assert.ok(roleEnum.includes('super_admin'));
    assert.ok(roleEnum.includes('clinic_admin'));
    assert.ok(roleEnum.includes('cardiologist'));
    assert.ok(roleEnum.includes('patient_b2c'));
    assert.ok(roleEnum.includes('doctor'));
    assert.ok(roleEnum.includes('technician'));
  });

  it('should have correct Organization schema fields', () => {
    const { Organization } = require('../src/models/saas');
    const paths = Object.keys(Organization.schema.paths);
    assert.ok(paths.includes('name'));
    assert.ok(paths.includes('slug'));
    assert.ok(paths.includes('type'));
    assert.ok(paths.includes('email'));
    assert.ok(paths.includes('subscriptionStatus'));
    assert.ok(paths.includes('creditsBalance'));
    assert.ok(paths.includes('isActive'));
  });

  it('should have correct SubscriptionPlan schema fields', () => {
    const { SubscriptionPlan } = require('../src/models/saas');
    const paths = Object.keys(SubscriptionPlan.schema.paths);
    assert.ok(paths.includes('name'));
    assert.ok(paths.includes('tier'));
    assert.ok(paths.includes('priceMonthly'));
    assert.ok(paths.includes('studyLimit'));
    assert.ok(paths.includes('isUnlimited'));
    assert.ok(paths.includes('payPerStudyPrice'));
    assert.ok(paths.includes('rpmPricePerPatient'));
    assert.ok(paths.includes('features'));
  });

  it('should have correct Invoice schema with items', () => {
    const { Invoice } = require('../src/models/saas');
    const paths = Object.keys(Invoice.schema.paths);
    assert.ok(paths.includes('invoiceNumber'));
    assert.ok(paths.includes('total'));
    assert.ok(paths.includes('status'));
    assert.ok(paths.includes('items'));
    assert.ok(paths.includes('pdfUrl'));
  });

  it('Organization type enum should have all types', () => {
    const { Organization } = require('../src/models/saas');
    const typeEnum = Organization.schema.paths.type.enumValues;
    assert.ok(typeEnum.includes('clinic'));
    assert.ok(typeEnum.includes('hospital'));
    assert.ok(typeEnum.includes('insurance'));
    assert.ok(typeEnum.includes('b2c_patient'));
    assert.ok(typeEnum.includes('enterprise'));
  });
});

// ─── Test: Service Logic (Unit) ─────────────────────────────────────────────

describe('Service Modules Load', () => {
  it('should load OrganizationService without errors', () => {
    const svc = require('../src/services/organization.service');
    assert.ok(svc.createOrganization);
    assert.ok(svc.getOrganization);
    assert.ok(svc.listOrganizations);
    assert.ok(svc.updateOrganization);
    assert.ok(svc.suspendOrganization);
    assert.ok(svc.getOrganizationUsage);
    assert.ok(svc.getOrganizationStatistics);
  });

  it('should load SubscriptionService without errors', () => {
    const svc = require('../src/services/subscription.service');
    assert.ok(svc.listPlans);
    assert.ok(svc.assignPlan);
    assert.ok(svc.upgradePlan);
    assert.ok(svc.downgradePlan);
    assert.ok(svc.cancelSubscription);
    assert.ok(svc.checkLimits);
  });

  it('should load CreditService without errors', () => {
    const svc = require('../src/services/credit.service');
    assert.ok(svc.purchaseCredits);
    assert.ok(svc.deductCredit);
    assert.ok(svc.getBalance);
    assert.ok(svc.getHistory);
  });

  it('should load BillingService without errors', () => {
    const svc = require('../src/services/billing.service');
    assert.ok(svc.generateInvoice);
    assert.ok(svc.generateInvoicePDF);
    assert.ok(svc.markAsPaid);
    assert.ok(svc.getInvoiceHistory);
  });

  it('should load UsageTrackingService without errors', () => {
    const svc = require('../src/services/usage-tracking.service');
    assert.ok(svc.trackStudyProcessed);
    assert.ok(svc.trackRPMPatient);
    assert.ok(svc.getMonthlyUsage);
    assert.ok(svc.checkAndEnforceLimits);
  });
});

// ─── Test: Route Modules Load ───────────────────────────────────────────────

describe('Route Modules Load', () => {
  it('should load all SaaS route modules', () => {
    const orgRoutes = require('../src/routes/organizationRoutes');
    const subRoutes = require('../src/routes/subscriptionRoutes');
    const creditRoutes = require('../src/routes/creditRoutes');
    const billingRoutes = require('../src/routes/billingRoutes');
    const invitationRoutes = require('../src/routes/invitationRoutes');
    const rpmRoutes = require('../src/routes/rpmRoutes');

    assert.equal(typeof orgRoutes, 'function');
    assert.equal(typeof subRoutes, 'function');
    assert.equal(typeof creditRoutes, 'function');
    assert.equal(typeof billingRoutes, 'function');
    assert.equal(typeof invitationRoutes, 'function');
    assert.equal(typeof rpmRoutes, 'function');
  });
});

// ─── Test: Seed Data ─────────────────────────────────────────────────────────

describe('Seed Data', () => {
  it('should have 5 plans defined', () => {
    const { plans } = require('../prisma/seeds/plans.seed');
    assert.equal(plans.length, 5);
  });

  it('should have all required plan tiers', () => {
    const { plans } = require('../prisma/seeds/plans.seed');
    const tiers = plans.map(p => p.tier);
    assert.ok(tiers.includes('basic'));
    assert.ok(tiers.includes('pro'));
    assert.ok(tiers.includes('enterprise'));
    assert.ok(tiers.includes('rpm'));
    assert.ok(tiers.includes('b2c'));
  });

  it('should have correct pricing for basic plan', () => {
    const { plans } = require('../prisma/seeds/plans.seed');
    const basic = plans.find(p => p.tier === 'basic');
    assert.equal(basic.priceMonthly, 300);
    assert.equal(basic.studyLimit, 30);
    assert.equal(basic.payPerStudyPrice, 45);
    assert.equal(basic.isUnlimited, false);
  });

  it('should have pro plan as unlimited', () => {
    const { plans } = require('../prisma/seeds/plans.seed');
    const pro = plans.find(p => p.tier === 'pro');
    assert.equal(pro.priceMonthly, 900);
    assert.equal(pro.isUnlimited, true);
  });

  it('should have RPM pricing', () => {
    const { plans } = require('../prisma/seeds/plans.seed');
    const rpm = plans.find(p => p.tier === 'rpm');
    assert.equal(rpm.rpmPricePerPatient, 25);
  });

  it('should have B2C pay-per-study price', () => {
    const { plans } = require('../prisma/seeds/plans.seed');
    const b2c = plans.find(p => p.tier === 'b2c');
    assert.equal(b2c.payPerStudyPrice, 60);
  });
});

console.log('✅ SaaS Multi-Tenancy tests loaded');
