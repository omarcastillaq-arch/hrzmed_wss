const mongoose = require('mongoose');

const testConnection = async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/hrzsignaldb';
    console.log('Connecting to:', uri);
    
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    
    console.log('✓ Connected to MongoDB');
    console.log('Database:', mongoose.connection.name);
    
    // List collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));
    
    await mongoose.disconnect();
    console.log('✓ Disconnected');
  } catch (error) {
    console.error('✗ Connection error:', error.message);
    process.exit(1);
  }
};

testConnection();
