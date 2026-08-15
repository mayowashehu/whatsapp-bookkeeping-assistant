import mongoose from 'mongoose';
import env from './env.js';

let listenersAttached = false;

/**
 * Attach connection event listeners once.
 * Mongoose/MongoDB driver handles reconnection automatically after the
 * initial successful connect; we only log lifecycle events here.
 */
function attachConnectionListeners() {
  if (listenersAttached) {
    return;
  }

  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected');
  });

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('MongoDB reconnected');
  });
}

/**
 * Connect to MongoDB using MONGODB_URI.
 * Fail fast if the URI is missing or the initial connection fails.
 */
export async function connectDatabase() {
  if (!env.mongodbUri) {
    throw new Error(
      'MONGODB_URI is missing. Set it in your .env file before starting the server.',
    );
  }

  attachConnectionListeners();

  try {
    // Atlas-ready: URI comes only from env. Driver reconnects after initial success.
    await mongoose.connect(env.mongodbUri, {
      serverSelectionTimeoutMS: 10_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to MongoDB: ${message}`);
  }
}

/**
 * Close the MongoDB connection cleanly during application shutdown.
 */
export async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.connection.close();
  console.log('MongoDB connection closed');
}

export default {
  connectDatabase,
  disconnectDatabase,
};
