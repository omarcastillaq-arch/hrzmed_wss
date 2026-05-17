const mongoose = require('mongoose');
const crypto = require('crypto');
const { Organization, MedicalUser, SubscriptionPlan } = require('./src/models');

const generateUserId = () => {
  return crypto.randomUUID();
};

const createTestData = async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/horizon_medical';
    console.log('Connecting to:', uri);
    
    await mongoose.connect(uri);
    console.log('✓ Connected to MongoDB\n');
    
    // Get a subscription plan
    const basicPlan = await SubscriptionPlan.findOne({ tier: 'basic' });
    if (!basicPlan) {
      throw new Error('Basic subscription plan not found. Please run seed first.');
    }
    console.log('✓ Found subscription plan:', basicPlan.name);
    
    // Create test organization
    console.log('\n--- Creating Test Organization ---');
    
    let org = await Organization.findOne({ name: 'Clínica Demo' });
    if (!org) {
      org = await Organization.create({
        name: 'Clínica Demo',
        type: 'clinic',
        address: 'Calle 45 #23-50, Bogotá, Colombia',
        phone: '+57 1 2345678',
        email: 'info@clinicademo.com',
        subscriptionPlan: basicPlan._id,
        status: 'active',
      });
      console.log('✅ Organization created: Clínica Demo');
    } else {
      console.log('⏭  Organization already exists: Clínica Demo');
    }
    console.log('   ID:', org._id.toString());
    console.log('   Type:', org.type);
    
    // Create super_admin user
    console.log('\n--- Creating Super Admin User ---');
    const adminPassword = 'admin123';
    const adminHash = MedicalUser.hashPassword(adminPassword);
    
    let adminUser = await MedicalUser.findOne({ email: 'admin@demo.com' });
    if (!adminUser) {
      adminUser = await MedicalUser.create({
        userId: generateUserId(),
        email: 'admin@demo.com',
        passwordHash: adminHash,
        firstName: 'Admin',
        lastName: 'Horizon',
        role: 'super_admin',
        organizationId: org._id,
        status: 'active',
        lastLogin: new Date(),
      });
      console.log('✅ Super Admin user created');
    } else {
      console.log('⏭  Super Admin user already exists');
      adminUser.passwordHash = adminHash;
      await adminUser.save();
      console.log('   (Password updated)');
    }
    console.log('   Email:', adminUser.email);
    console.log('   Role:', adminUser.role);
    console.log('   User ID:', adminUser.userId);
    
    // Create clinic_admin user
    console.log('\n--- Creating Clinic Admin User ---');
    const clinicPassword = 'clinic123';
    const clinicHash = MedicalUser.hashPassword(clinicPassword);
    
    let clinicUser = await MedicalUser.findOne({ email: 'clinic@demo.com' });
    if (!clinicUser) {
      clinicUser = await MedicalUser.create({
        userId: generateUserId(),
        email: 'clinic@demo.com',
        passwordHash: clinicHash,
        firstName: 'Clínica',
        lastName: 'Admin',
        role: 'clinic_admin',
        organizationId: org._id,
        status: 'active',
        lastLogin: new Date(),
      });
      console.log('✅ Clinic Admin user created');
    } else {
      console.log('⏭  Clinic Admin user already exists');
      clinicUser.passwordHash = clinicHash;
      await clinicUser.save();
      console.log('   (Password updated)');
    }
    console.log('   Email:', clinicUser.email);
    console.log('   Role:', clinicUser.role);
    console.log('   User ID:', clinicUser.userId);
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ TEST DATA CREATED SUCCESSFULLY');
    console.log('='.repeat(60));
    console.log('\n📋 LOGIN CREDENTIALS:\n');
    console.log('Organization: Clínica Demo');
    console.log('Organization ID:', org._id.toString());
    console.log('\n👤 Super Admin Account:');
    console.log('   Email: admin@demo.com');
    console.log('   Password: admin123');
    console.log('   Role: super_admin');
    console.log('   User ID:', adminUser.userId);
    console.log('\n👤 Clinic Admin Account:');
    console.log('   Email: clinic@demo.com');
    console.log('   Password: clinic123');
    console.log('   Role: clinic_admin');
    console.log('   User ID:', clinicUser.userId);
    console.log('\n' + '='.repeat(60));
    
    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
};

createTestData();
