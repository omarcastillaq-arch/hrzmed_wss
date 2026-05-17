/**
 * @module billingRoutes
 * @description REST API routes for billing/invoice management.
 *
 * Routes:
 *   GET    /api/v1/organizations/:id/invoices                     - List invoices
 *   POST   /api/v1/organizations/:id/invoices                     - Generate invoice
 *   GET    /api/v1/organizations/:id/invoices/:invoiceId          - Get invoice
 *   GET    /api/v1/organizations/:id/invoices/:invoiceId/pdf      - Download PDF
 *   POST   /api/v1/organizations/:id/invoices/:invoiceId/pay      - Mark as paid
 */

'use strict';

const billingService = require('../services/billing.service');
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

async function handleBillingRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJSON(res, 200, {});

  extractTenantContext(req, res, () => {});

  try {
    // Match /api/v1/organizations/:id/invoices...
    const match = path.match(/^\/api\/v1\/organizations\/([a-f0-9]{24})\/invoices(\/.*)?$/);
    if (!match) return null;

    const orgId = match[1];
    const subPath = match[2] || '';

    if (!req.isSuperAdmin && !verifyOrgAccess(req, orgId)) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }

    // GET /invoices — List
    if (subPath === '' && method === 'GET') {
      if (!checkPermission('billing.view')(req, res)) return;
      const query = parseQuery(req.url);
      const result = await billingService.getInvoiceHistory(orgId, {
        page: parseInt(query.page) || 1,
        limit: parseInt(query.limit) || 20,
        status: query.status,
      });
      return sendJSON(res, 200, { success: true, ...result });
    }

    // POST /invoices — Generate new invoice
    if (subPath === '' && method === 'POST') {
      if (!checkPermission('billing.manage')(req, res)) return;
      const body = await parseBody(req);
      const invoice = await billingService.generateInvoice(orgId, body.month, body.year, {
        taxRate: body.taxRate,
        notes: body.notes,
        additionalItems: body.additionalItems,
        createdBy: req.userId,
      });
      return sendJSON(res, 201, { success: true, data: invoice });
    }

    // Match /invoices/:invoiceId...
    const invoiceMatch = subPath.match(/^\/([a-f0-9]{24})(\/.*)?$/);
    if (invoiceMatch) {
      const invoiceId = invoiceMatch[1];
      const invoiceSubPath = invoiceMatch[2] || '';

      // GET /invoices/:invoiceId
      if (invoiceSubPath === '' && method === 'GET') {
        if (!checkPermission('billing.view')(req, res)) return;
        const invoice = await billingService.getInvoice(invoiceId);
        if (!invoice) return sendJSON(res, 404, { error: 'Invoice not found' });
        return sendJSON(res, 200, { success: true, data: invoice });
      }

      // GET /invoices/:invoiceId/pdf
      if (invoiceSubPath === '/pdf' && method === 'GET') {
        if (!checkPermission('billing.view')(req, res)) return;
        const pdfBuffer = await billingService.generateInvoicePDF(invoiceId);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="invoice-${invoiceId}.pdf"`,
          'Content-Length': pdfBuffer.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(pdfBuffer);
        return;
      }

      // POST /invoices/:invoiceId/pay
      if (invoiceSubPath === '/pay' && method === 'POST') {
        if (!checkPermission('billing.manage')(req, res)) return;
        const body = await parseBody(req);
        const invoice = await billingService.markAsPaid(invoiceId, body);
        return sendJSON(res, 200, { success: true, data: invoice });
      }
    }

    return null;
  } catch (error) {
    logger.error('Billing route error', { error: error.message, path });
    return sendJSON(res, error.message.includes('not found') ? 404 : 400, {
      success: false, error: error.message,
    });
  }
}

module.exports = handleBillingRoutes;
