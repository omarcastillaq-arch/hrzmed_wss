/**
 * @module rbac.middleware
 * @description Role-Based Access Control middleware for Horizon Medical SaaS.
 *
 * Defines role hierarchy, permissions, and access control checks.
 * Roles: SUPER_ADMIN > CLINIC_ADMIN > CARDIOLOGIST/DOCTOR > TECHNICIAN > PATIENT_B2C
 */

'use strict';

const logger = require('../utils/logger');

// ─── Role Definitions ────────────────────────────────────────────────────────
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  CLINIC_ADMIN: 'clinic_admin',
  DOCTOR: 'doctor',
  CARDIOLOGIST: 'cardiologist',
  NURSE: 'nurse',
  ADMIN: 'admin',
  TECHNICIAN: 'technician',
  PATIENT_B2C: 'patient_b2c',
};

// ─── Role Hierarchy (higher number = more privileges) ────────────────────────
const ROLE_HIERARCHY = {
  [ROLES.SUPER_ADMIN]: 100,
  [ROLES.CLINIC_ADMIN]: 80,
  [ROLES.ADMIN]: 80,
  [ROLES.DOCTOR]: 60,
  [ROLES.CARDIOLOGIST]: 60,
  [ROLES.NURSE]: 50,
  [ROLES.TECHNICIAN]: 40,
  [ROLES.PATIENT_B2C]: 10,
};

// ─── Permission Definitions ──────────────────────────────────────────────────
const PERMISSIONS = {
  // Organization management
  'organizations.create': [ROLES.SUPER_ADMIN],
  'organizations.list': [ROLES.SUPER_ADMIN],
  'organizations.read': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],
  'organizations.update': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN],
  'organizations.delete': [ROLES.SUPER_ADMIN],
  'organizations.suspend': [ROLES.SUPER_ADMIN],

  // Subscription management
  'subscriptions.manage': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN],
  'subscriptions.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],

  // Credits
  'credits.purchase': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN],
  'credits.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],

  // Billing / Invoices
  'billing.manage': [ROLES.SUPER_ADMIN],
  'billing.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],

  // User management
  'users.create': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],
  'users.list': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],
  'users.update': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],
  'users.delete': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN],
  'users.invite': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],

  // Patient management
  'patients.create': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN],
  'patients.list': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN],
  'patients.read': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN, ROLES.PATIENT_B2C],
  'patients.update': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE],
  'patients.delete': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN],

  // Devices
  'devices.manage': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.TECHNICIAN],
  'devices.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN],

  // ECG Sessions / Studies
  'sessions.create': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN],
  'sessions.list': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN],
  'sessions.read': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN, ROLES.PATIENT_B2C],
  'sessions.export': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST],

  // Reports
  'reports.generate': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST],
  'reports.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN, ROLES.PATIENT_B2C],

  // Notifications
  'notifications.manage': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],
  'notifications.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN, ROLES.PATIENT_B2C],

  // RPM
  'rpm.manage': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST],
  'rpm.view': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN, ROLES.DOCTOR, ROLES.CARDIOLOGIST, ROLES.NURSE, ROLES.TECHNICIAN],

  // System / Analytics
  'system.admin': [ROLES.SUPER_ADMIN],
  'analytics.global': [ROLES.SUPER_ADMIN],
  'analytics.org': [ROLES.SUPER_ADMIN, ROLES.CLINIC_ADMIN, ROLES.ADMIN],
};

/**
 * Check if a role has a specific permission.
 */
function hasPermission(role, permission) {
  const allowedRoles = PERMISSIONS[permission];
  if (!allowedRoles) return false;
  return allowedRoles.includes(role);
}

/**
 * Check if roleA has equal or higher privileges than roleB.
 */
function isRoleAtLeast(roleA, roleB) {
  return (ROLE_HIERARCHY[roleA] || 0) >= (ROLE_HIERARCHY[roleB] || 0);
}

/**
 * Middleware factory: Require specific roles.
 * Usage: requireRole(['clinic_admin', 'super_admin'])
 */
function requireRole(allowedRoles) {
  return function _requireRole(req, res) {
    const userRole = req.userRole || req.user?.role;
    if (!userRole) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', message: 'Authentication required' }));
      return false;
    }

    if (!allowedRoles.includes(userRole) && userRole !== ROLES.SUPER_ADMIN) {
      logger.security('rbac_denied', {
        userId: req.userId,
        role: userRole,
        requiredRoles: allowedRoles,
        path: req.url,
      });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`,
      }));
      return false;
    }

    return true;
  };
}

/**
 * Middleware factory: Require specific permission.
 * Usage: checkPermission('patients.create')
 */
function checkPermission(permission) {
  return function _checkPermission(req, res) {
    const userRole = req.userRole || req.user?.role;
    if (!userRole) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }

    if (!hasPermission(userRole, permission)) {
      logger.security('permission_denied', {
        userId: req.userId,
        role: userRole,
        permission,
        path: req.url,
      });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: `Insufficient permissions: ${permission} required`,
      }));
      return false;
    }

    return true;
  };
}

/**
 * Get all permissions for a given role.
 */
function getRolePermissions(role) {
  const perms = [];
  for (const [perm, roles] of Object.entries(PERMISSIONS)) {
    if (roles.includes(role)) {
      perms.push(perm);
    }
  }
  return perms;
}

module.exports = {
  ROLES,
  ROLE_HIERARCHY,
  PERMISSIONS,
  hasPermission,
  isRoleAtLeast,
  requireRole,
  checkPermission,
  getRolePermissions,
};
