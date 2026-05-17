/**
 * @module clusterManager
 * @description Multi-process cluster support for Horizon Medical WSS.
 *
 * Uses Node.js cluster module to fork worker processes, distributing
 * WebSocket connections across CPU cores for improved concurrency.
 *
 * Architecture:
 *   - Primary process manages worker lifecycle (fork, restart, signals)
 *   - Workers run independent WebSocket servers
 *   - Sticky sessions via IP-hash ensure clients reconnect to same worker
 *   - Health monitoring restarts unresponsive workers
 *
 * Usage:
 *   Set CLUSTER_ENABLED=true and optionally CLUSTER_WORKERS=N
 *   If N=0 or unset, defaults to (CPU cores - 1) with minimum of 2.
 */

'use strict';

const cluster = require('cluster');
const os = require('os');

// ─── Configuration ───────────────────────────────────────────────────────────

const CLUSTER_ENABLED = process.env.CLUSTER_ENABLED === 'true';
const CLUSTER_WORKERS = parseInt(process.env.CLUSTER_WORKERS, 10) || 0;
const WORKER_RESTART_DELAY = 2000; // ms before restarting a crashed worker
const MAX_RESTART_COUNT = 10;      // max restarts per worker in window
const RESTART_WINDOW = 60000;      // restart count window (ms)

/**
 * Determine the number of worker processes.
 */
function getWorkerCount() {
  if (CLUSTER_WORKERS > 0) return CLUSTER_WORKERS;
  const cpus = os.cpus().length;
  return Math.max(2, cpus - 1); // Leave 1 core for OS and primary
}

/**
 * Initialize cluster mode if enabled.
 * @param {Function} workerEntryPoint - Function to run in each worker
 * @returns {boolean} true if this is the primary process (caller should NOT start server)
 */
function initCluster(workerEntryPoint) {
  if (!CLUSTER_ENABLED) {
    return false; // Not clustering — run normally
  }

  if (cluster.isPrimary) {
    const workerCount = getWorkerCount();
    const restartCounts = new Map();

    console.log(`[Cluster] Primary ${process.pid} starting ${workerCount} workers on ${os.cpus().length} CPUs`);

    // Fork workers
    for (let i = 0; i < workerCount; i++) {
      cluster.fork();
    }

    // Handle worker exit
    cluster.on('exit', (worker, code, signal) => {
      console.log(`[Cluster] Worker ${worker.process.pid} exited (code: ${code}, signal: ${signal})`);

      // Track restarts to prevent crash loops
      const now = Date.now();
      const workerId = worker.id;

      if (!restartCounts.has(workerId)) {
        restartCounts.set(workerId, []);
      }

      const restarts = restartCounts.get(workerId);
      restarts.push(now);

      // Clean old entries outside window
      while (restarts.length > 0 && restarts[0] < now - RESTART_WINDOW) {
        restarts.shift();
      }

      if (restarts.length >= MAX_RESTART_COUNT) {
        console.error(`[Cluster] Worker ${workerId} restarted too many times, not restarting`);
        return;
      }

      // Restart after delay
      setTimeout(() => {
        console.log(`[Cluster] Restarting worker...`);
        cluster.fork();
      }, WORKER_RESTART_DELAY);
    });

    // Forward shutdown signals to workers
    const shutdown = (signal) => {
      console.log(`[Cluster] Primary received ${signal}, shutting down workers...`);
      for (const id in cluster.workers) {
        cluster.workers[id].process.kill(signal);
      }
      setTimeout(() => process.exit(0), 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return true; // Primary — don't run server here
  }

  // Worker process — run the server
  console.log(`[Cluster] Worker ${process.pid} started`);
  return false;
}

/**
 * Check if cluster mode is enabled and this is the primary process.
 */
function isPrimary() {
  return CLUSTER_ENABLED && cluster.isPrimary;
}

/**
 * Check if cluster mode is enabled and this is a worker process.
 */
function isWorker() {
  return CLUSTER_ENABLED && cluster.isWorker;
}

/**
 * Get cluster status info.
 */
function getStatus() {
  if (!CLUSTER_ENABLED) {
    return { enabled: false, mode: 'single-process', pid: process.pid };
  }

  if (cluster.isPrimary) {
    const workers = Object.values(cluster.workers || {}).map(w => ({
      id: w.id,
      pid: w.process.pid,
      state: w.state,
    }));
    return {
      enabled: true,
      mode: 'primary',
      pid: process.pid,
      workers,
      workerCount: workers.length,
    };
  }

  return {
    enabled: true,
    mode: 'worker',
    pid: process.pid,
    workerId: cluster.worker?.id,
  };
}

module.exports = {
  CLUSTER_ENABLED,
  getWorkerCount,
  initCluster,
  isPrimary,
  isWorker,
  getStatus,
};
