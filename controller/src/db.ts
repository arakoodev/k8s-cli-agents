import pg from 'pg';
import pino from 'pino';

const { Pool } = pg;
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Add connection pool configuration
  max: 20, // Maximum number of clients
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Timeout after 10 seconds trying to connect
  // Enable SSL for Cloud SQL
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

// Track pool health
let isPoolHealthy = true;

pool.on('error', (err, client) => {
  log.error({ err }, 'Database pool error - attempting recovery');
  isPoolHealthy = false;

  // Set a timer to mark as healthy again after a short period
  setTimeout(() => {
    isPoolHealthy = true;
  }, 5000);

  // DO NOT call process.exit() - let the pool reconnect automatically
});

pool.on('connect', (client) => {
  log.debug('New database client connected');
  isPoolHealthy = true;
});

pool.on('remove', (client) => {
  log.debug('Database client removed from pool');
});

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  if (!isPoolHealthy) {
    return false;
  }

  try {
    const result = await pool.query('SELECT 1');
    return result.rows.length === 1;
  } catch (err) {
    log.error({ err }, 'Database health check failed');
    return false;
  }
}

// Graceful shutdown
export async function closeDatabasePool(): Promise<void> {
  log.info('Closing database pool');
  await pool.end();
}

// Handle process termination
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, closing database pool');
  await closeDatabasePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, closing database pool');
  await closeDatabasePool();
  process.exit(0);
});