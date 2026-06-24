const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

// Manually load .env variables if present
if (fs.existsSync(path.join(__dirname, '.env'))) {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
    envFile.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index !== -1) {
        const key = trimmed.substring(0, index).trim();
        let value = trimmed.substring(index + 1).trim();
        // Remove surrounding quotes if they exist
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.substring(1, value.length - 1);
        }
        if (key === 'GOOGLE_CLIENT_ID') return;
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    });
  } catch (err) {
    console.error('Failed to read .env file:', err);
  }
}

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/fittrack';

const app = express();
let pool;
let dbAvailable = false;

try {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
  });
} catch (err) {
  console.warn('Could not create database pool:', err.message);
  pool = null;
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Middleware to check DB availability
function requireDb(req, res, next) {
  if (!dbAvailable || !pool) {
    return res.status(503).json({ error: 'Database not available. Data is saved locally in your browser.' });
  }
  next();
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
      water_intake INTEGER NOT NULL DEFAULT 0 CHECK (water_intake >= 0 AND water_intake <= 8),
      totals JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, log_date),
      FOREIGN KEY (user_id) REFERENCES fittrack_profiles(user_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS fittrack_daily_logs_user_date_idx
    ON fittrack_daily_logs (user_id, log_date DESC);
  `);
}

function toWeeklyData(rows) {
  return rows.reduce((acc, row) => {
    const key = row.log_date instanceof Date ? row.log_date.toISOString().slice(0, 10) : String(row.log_date).slice(0, 10);
    acc[key] = Number(row.protein || 0);
    return acc;
  }, {});
}

app.get('/api/health', async (req, res) => {
  if (!dbAvailable || !pool) return res.json({ ok: false, db: false });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (err) {
    res.json({ ok: true, db: false });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null
  });
});

app.get('/api/daily/:userId/:date', requireDb, async (req, res) => {
  const { userId, date } = req.params;
  console.log(`[Database] Fetching daily log for User: ${userId}, Date: ${date}`);
  const client = await pool.connect();
  try {
    const profileResult = await client.query('SELECT profile FROM fittrack_profiles WHERE user_id = $1', [userId]);
    const logResult = await client.query(
      'SELECT food_log, water_intake, totals FROM fittrack_daily_logs WHERE user_id = $1 AND log_date = $2',
      [userId, date]
    );
    const weeklyResult = await client.query(
      `SELECT log_date, COALESCE((totals->>'protein')::numeric, 0) AS protein
       FROM fittrack_daily_logs
       WHERE user_id = $1 AND log_date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date
       ORDER BY log_date`,
      [userId, date]
    );
    const logRow = logResult.rows[0];
    res.json({
      profile: profileResult.rows[0]?.profile || null,
      log: logRow?.food_log || [],
      waterIntake: logRow?.water_intake ?? 0,
      totals: logRow?.totals || {},
      weeklyData: toWeeklyData(weeklyResult.rows)
    });
  } finally {
    client.release();
  }
});

app.get('/api/history/:userId', requireDb, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 30), 365);
  const { userId } = req.params;
  console.log(`[Database] Fetching history for User: ${userId} (Limit: ${limit} days)`);
  const result = await pool.query(
    `SELECT log_date, food_log, water_intake, totals, updated_at
     FROM fittrack_daily_logs
     WHERE user_id = $1
     ORDER BY log_date DESC
     LIMIT $2`,
    [req.params.userId, limit]
  );
  res.json({ days: result.rows });
});

app.put('/api/daily/:userId/:date', requireDb, async (req, res) => {
  const { userId, date } = req.params;
  const { profile, log = [], waterIntake = 0, totals = {} } = req.body;
  console.log(`[Database] Updating daily stats for User: ${userId}, Date: ${date}. Log size: ${log.length} items, Water: ${waterIntake} cups`);
  if (!profile) {
    res.status(400).json({ error: 'profile is required' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fittrack_profiles (user_id, profile, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
      [userId, JSON.stringify(profile)]
    );
    await client.query(
      `INSERT INTO fittrack_daily_logs (user_id, log_date, food_log, water_intake, totals, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, log_date)
       DO UPDATE SET food_log = EXCLUDED.food_log,
                     water_intake = EXCLUDED.water_intake,
                     totals = EXCLUDED.totals,
                     updated_at = NOW()`,
      [userId, date, JSON.stringify(log), waterIntake, JSON.stringify(totals)]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/users/:userId', requireDb, async (req, res) => {
  const { userId } = req.params;
  console.log(`[Database] Deleting account and all logs for User: ${userId}`);
  await pool.query('DELETE FROM fittrack_profiles WHERE user_id = $1', [userId]);
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(`[Error] Unhandled error during request ${req.method} ${req.originalUrl}:`, error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server even if DB is unavailable
async function startServer() {
  if (pool) {
    try {
      await initDb();
      dbAvailable = true;
      console.log('Database connected and tables initialized.');
    } catch (error) {
      console.warn('Database not available — running in offline mode.');
      console.warn('Reason:', error.message);
      dbAvailable = false;
    }
  }

  app.listen(PORT, () => {
    console.log(`FitTrack Pro running at http://localhost:${PORT}`);
    if (!dbAvailable) {
      console.log('Note: Running without database. All data is stored in the browser\'s localStorage.');
    }
  });
}

startServer();
