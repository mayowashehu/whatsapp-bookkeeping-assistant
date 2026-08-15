
import app from './app.js';
import env from './config/env.js';
import { assertRequiredEnv } from './config/validateEnv.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { startTempCleanupCron } from './utils/tempCleanup.service.js';
import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]); // Uses Google's public DNS
import { startDraftReminderDaemon } from './services/draft/DraftReminderService.js';


/**
 * Process entry point.
 * Validates required env, connects to MongoDB, then starts HTTP listening.
 * HTTP server never starts if validation or DB connection fails.
 */
async function start() {
  try {
    assertRequiredEnv(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  try {
    await connectDatabase();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    console.log(`Server listening on port ${env.port} (${env.nodeEnv})`);
    startTempCleanupCron();
  });

  let isShuttingDown = false;

  async function shutdown(signal) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    console.log(`${signal} received. Shutting down gracefully...`);

    server.close(async () => {
      console.log('HTTP server closed.');
      try {
        await disconnectDatabase();
        process.exit(0);
      } catch (err) {
        console.error('Error while closing MongoDB connection:', err);
        process.exit(1);
      }
    });
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

void start();
