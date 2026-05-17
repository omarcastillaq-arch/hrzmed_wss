/**
 * @module plans.seed
 * @description Seed subscription plans for Horizon Medical SaaS platform.
 *
 * Usage: node prisma/seeds/plans.seed.js
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { SubscriptionPlan } = require('../../src/models');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/horizon_medical';

const plans = [
  {
    name: 'Básico',
    tier: 'basic',
    description: 'Plan inicial para clínicas pequeñas. Incluye hasta 30 estudios mensuales con soporte básico.',
    priceMonthly: 300,
    priceYearly: 3000,
    currency: 'USD',
    studyLimit: 30,
    isUnlimited: false,
    maxUsers: 5,
    maxDevices: 3,
    payPerStudyPrice: 45,
    rpmPricePerPatient: 0,
    rpmMaxPatients: 0,
    features: {
      ecg_recording: true,
      basic_reports: true,
      pdf_export: true,
      email_notifications: true,
      api_access: false,
      custom_branding: false,
      priority_support: false,
      rpm: false,
      ai_analysis: false,
    },
    sortOrder: 1,
  },
  {
    name: 'Pro',
    tier: 'pro',
    description: 'Plan profesional con estudios ilimitados, alertas avanzadas y acceso API.',
    priceMonthly: 900,
    priceYearly: 9000,
    currency: 'USD',
    studyLimit: 0,
    isUnlimited: true,
    maxUsers: 25,
    maxDevices: 15,
    payPerStudyPrice: 35,
    rpmPricePerPatient: 25,
    rpmMaxPatients: 50,
    features: {
      ecg_recording: true,
      basic_reports: true,
      advanced_reports: true,
      pdf_export: true,
      edf_export: true,
      hl7_export: true,
      email_notifications: true,
      sms_notifications: true,
      api_access: true,
      custom_branding: true,
      priority_support: true,
      rpm: true,
      ai_analysis: true,
      real_time_alerts: true,
    },
    sortOrder: 2,
  },
  {
    name: 'Enterprise',
    tier: 'enterprise',
    description: 'Plan empresarial con precios personalizados, SLA dedicado y soporte premium.',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'USD',
    studyLimit: 0,
    isUnlimited: true,
    maxUsers: 999,
    maxDevices: 999,
    payPerStudyPrice: 0,
    rpmPricePerPatient: 0,
    rpmMaxPatients: 999,
    features: {
      ecg_recording: true,
      basic_reports: true,
      advanced_reports: true,
      pdf_export: true,
      edf_export: true,
      hl7_export: true,
      email_notifications: true,
      sms_notifications: true,
      api_access: true,
      custom_branding: true,
      priority_support: true,
      dedicated_support: true,
      rpm: true,
      ai_analysis: true,
      real_time_alerts: true,
      sla_guarantee: true,
      white_label: true,
      custom_integrations: true,
      on_premise_option: true,
    },
    sortOrder: 3,
  },
  {
    name: 'RPM',
    tier: 'rpm',
    description: 'Plan especializado en monitoreo remoto de pacientes. Precio por paciente/mes.',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'USD',
    studyLimit: 0,
    isUnlimited: true,
    maxUsers: 50,
    maxDevices: 100,
    payPerStudyPrice: 0,
    rpmPricePerPatient: 25,
    rpmMaxPatients: 200,
    features: {
      ecg_recording: true,
      basic_reports: true,
      advanced_reports: true,
      pdf_export: true,
      email_notifications: true,
      sms_notifications: true,
      api_access: true,
      rpm: true,
      real_time_alerts: true,
      continuous_monitoring: true,
      patient_portal: true,
    },
    sortOrder: 4,
  },
  {
    name: 'B2C Individual',
    tier: 'b2c',
    description: 'Plan para pacientes individuales. Pago por estudio sin suscripción mensual.',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'USD',
    studyLimit: 0,
    isUnlimited: false,
    maxUsers: 1,
    maxDevices: 1,
    payPerStudyPrice: 60,
    rpmPricePerPatient: 40,
    rpmMaxPatients: 1,
    features: {
      ecg_recording: true,
      basic_reports: true,
      pdf_export: true,
      patient_portal: true,
      email_notifications: true,
    },
    sortOrder: 5,
  },
];

async function seedPlans() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    for (const plan of plans) {
      const existing = await SubscriptionPlan.findOne({ tier: plan.tier });
      if (existing) {
        console.log(`  ⏭  Plan "${plan.name}" (${plan.tier}) already exists, updating...`);
        Object.assign(existing, plan);
        await existing.save();
      } else {
        await SubscriptionPlan.create(plan);
        console.log(`  ✅ Plan "${plan.name}" (${plan.tier}) created`);
      }
    }

    console.log('\n✅ All plans seeded successfully!');
    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Seed error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  seedPlans();
}

module.exports = { plans, seedPlans };
