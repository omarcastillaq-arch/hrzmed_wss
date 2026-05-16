/**
 * @module BillingService
 * @description Business logic for manual invoice/billing management.
 */

'use strict';

const { Organization, Invoice, UsageTracking, Subscription, SubscriptionPlan } = require('../models');
const logger = require('../utils/logger');

class BillingService {
  /**
   * Generate an invoice for an organization for a specific period.
   */
  async generateInvoice(orgId, month, year, options = {}) {
    const org = await Organization.findById(orgId).populate('planId').lean();
    if (!org) throw new Error('Organization not found');

    const usage = await UsageTracking.findOne({
      organizationId: orgId,
      month,
      year,
    }).lean();

    const subscription = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trial'] },
    }).populate('planId').lean();

    const plan = subscription?.planId || org.planId;
    const items = [];

    // Subscription line item
    if (plan && plan.priceMonthly > 0) {
      items.push({
        description: `${plan.name} Plan - ${this._monthName(month)} ${year}`,
        quantity: 1,
        unitPrice: subscription?.customPricing?.monthlyPrice || plan.priceMonthly,
        total: subscription?.customPricing?.monthlyPrice || plan.priceMonthly,
        type: 'subscription',
      });
    }

    // Overage / pay-per-study charges
    if (usage && plan && !plan.isUnlimited && plan.studyLimit > 0) {
      const overage = Math.max(0, usage.studiesProcessed - plan.studyLimit);
      if (overage > 0 && plan.payPerStudyPrice > 0) {
        items.push({
          description: `Overage: ${overage} additional studies at $${plan.payPerStudyPrice}/study`,
          quantity: overage,
          unitPrice: plan.payPerStudyPrice,
          total: overage * plan.payPerStudyPrice,
          type: 'overage',
        });
      }
    }

    // RPM charges
    if (usage && usage.rpmPatientsActive > 0 && plan?.rpmPricePerPatient > 0) {
      items.push({
        description: `RPM Monitoring: ${usage.rpmPatientsActive} patients`,
        quantity: usage.rpmPatientsActive,
        unitPrice: plan.rpmPricePerPatient,
        total: usage.rpmPatientsActive * plan.rpmPricePerPatient,
        type: 'rpm',
      });
    }

    // Add custom items
    if (options.additionalItems) {
      items.push(...options.additionalItems);
    }

    const subtotal = items.reduce((sum, item) => sum + item.total, 0);
    const taxRate = options.taxRate || 16; // Default IVA Mexico
    const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    const total = subtotal + tax;

    const invoiceNumber = await Invoice.generateInvoiceNumber();
    const issueDate = new Date();
    const dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const invoice = new Invoice({
      organizationId: orgId,
      invoiceNumber,
      subtotal,
      tax,
      taxRate,
      total,
      currency: plan?.currency || org.settings?.currency || 'USD',
      status: 'pending',
      issueDate,
      dueDate,
      periodMonth: month,
      periodYear: year,
      items,
      notes: options.notes,
      createdBy: options.createdBy,
    });

    await invoice.save();
    logger.info('Invoice generated', { orgId, invoiceNumber, total });
    return invoice;
  }

  /**
   * Generate PDF for an invoice (returns buffer).
   */
  async generateInvoicePDF(invoiceId) {
    const invoice = await Invoice.findById(invoiceId)
      .populate({ path: 'organizationId', select: 'name email phone address' })
      .lean();

    if (!invoice) throw new Error('Invoice not found');

    // Use PDFKit to generate
    const PDFDocument = require('pdfkit');
    const chunks = [];

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(24).fillColor('#0891b2').text('HORIZON MEDICAL', { align: 'center' });
      doc.fontSize(10).fillColor('#666').text('Plataforma IoT Holter ECG', { align: 'center' });
      doc.moveDown(2);

      // Invoice info
      doc.fontSize(16).fillColor('#333').text(`Factura: ${invoice.invoiceNumber}`);
      doc.fontSize(10).fillColor('#666');
      doc.text(`Fecha: ${invoice.issueDate.toLocaleDateString('es-MX')}`);
      doc.text(`Vencimiento: ${invoice.dueDate.toLocaleDateString('es-MX')}`);
      doc.text(`Estado: ${invoice.status.toUpperCase()}`);
      doc.moveDown();

      // Client info
      const org = invoice.organizationId;
      doc.fontSize(12).fillColor('#333').text('Facturado a:');
      doc.fontSize(10).fillColor('#666');
      doc.text(org.name || 'N/A');
      doc.text(org.email || 'N/A');
      if (org.phone) doc.text(org.phone);
      doc.moveDown(2);

      // Items table header
      doc.fontSize(10).fillColor('#fff');
      doc.rect(50, doc.y, 512, 20).fill('#0891b2');
      const tableTop = doc.y + 5;
      doc.text('Descripción', 55, tableTop, { width: 250 });
      doc.text('Cant.', 310, tableTop, { width: 50, align: 'right' });
      doc.text('Precio Unit.', 370, tableTop, { width: 80, align: 'right' });
      doc.text('Total', 460, tableTop, { width: 95, align: 'right' });
      doc.moveDown();

      // Items
      let y = doc.y + 5;
      doc.fillColor('#333');
      for (const item of invoice.items) {
        doc.text(item.description, 55, y, { width: 250 });
        doc.text(String(item.quantity), 310, y, { width: 50, align: 'right' });
        doc.text(`$${item.unitPrice.toFixed(2)}`, 370, y, { width: 80, align: 'right' });
        doc.text(`$${item.total.toFixed(2)}`, 460, y, { width: 95, align: 'right' });
        y += 20;
      }

      // Totals
      doc.moveDown(2);
      y = doc.y;
      doc.fontSize(10);
      doc.text(`Subtotal: $${invoice.subtotal.toFixed(2)}`, 370, y, { width: 185, align: 'right' });
      doc.text(`IVA (${invoice.taxRate}%): $${invoice.tax.toFixed(2)}`, 370, y + 15, { width: 185, align: 'right' });
      doc.fontSize(14).fillColor('#0891b2');
      doc.text(`TOTAL: $${invoice.total.toFixed(2)} ${invoice.currency}`, 370, y + 35, { width: 185, align: 'right' });

      // Footer
      doc.fontSize(8).fillColor('#999');
      doc.text('Horizon Medical - Plataforma SaaS Multi-Tenant', 50, 700, { align: 'center' });

      doc.end();
    });
  }

  /**
   * Mark invoice as paid.
   */
  async markAsPaid(invoiceId, paymentDetails = {}) {
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    invoice.status = 'paid';
    invoice.paidAt = new Date();
    invoice.paymentMethod = paymentDetails.method || null;
    invoice.paymentReference = paymentDetails.reference || null;

    await invoice.save();
    logger.info('Invoice marked as paid', { invoiceId, amount: invoice.total });
    return invoice;
  }

  /**
   * Get invoice history for an organization.
   */
  async getInvoiceHistory(orgId, { page = 1, limit = 20, status } = {}) {
    const filter = { organizationId: orgId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;
    const [invoices, total] = await Promise.all([
      Invoice.find(filter).sort({ issueDate: -1 }).skip(skip).limit(limit).lean(),
      Invoice.countDocuments(filter),
    ]);

    return {
      invoices,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single invoice.
   */
  async getInvoice(invoiceId) {
    return Invoice.findById(invoiceId)
      .populate({ path: 'organizationId', select: 'name email' })
      .lean();
  }

  _monthName(month) {
    const names = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return names[month] || '';
  }
}

module.exports = new BillingService();
