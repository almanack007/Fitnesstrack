const { Pool } = require('pg');
const env = require('./env');

let pool;
let dbAvailable = false;

try {
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
  });
} catch (err) {
  console.warn('Could not create database pool:', err.message);
  pool = null;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fittrack_profiles (
      user_id TEXT PRIMARY KEY,
      profile JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fittrack_daily_logs (
      user_id TEXT NOT NULL,
      log_date DATE NOT NULL,
      food_log JSONB NOT NULL DEFAULT '[]'::jsonb,
      water_intake INTEGER NOT NULL DEFAULT 0 CHECK (water_intake >= 0),
      totals JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, log_date),
      FOREIGN KEY (user_id) REFERENCES fittrack_profiles(user_id) ON DELETE CASCADE
    );

    -- Migration: Drop the old 8-glass limit check constraint if it exists
    ALTER TABLE fittrack_daily_logs DROP CONSTRAINT IF EXISTS fittrack_daily_logs_water_intake_check;

    CREATE INDEX IF NOT EXISTS fittrack_daily_logs_user_date_idx
    ON fittrack_daily_logs (user_id, log_date DESC);
  `);
}

function requireDb(req, res, next) {
  if (!dbAvailable || !pool) {
    return res.status(503).json({ error: 'Database not available. Data is saved locally in your browser.' });
  }
  next();
}

function setDbAvailable(status) {
  dbAvailable = status;
}

function isDbAvailable() {
  return dbAvailable;
}

function getPool() {
  return pool;
}

module.exports = {
  getPool,
  initDb,
  requireDb,
  setDbAvailable,
  isDbAvailable
};
