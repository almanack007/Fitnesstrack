const db = require('../config/db');

function toWeeklyData(rows) {
  const proteins = {};
  const cals = {};
  const waters = {};
  const weights = {};
  rows.forEach(row => {
    const key = row.log_date instanceof Date ? row.log_date.toISOString().slice(0, 10) : String(row.log_date).slice(0, 10);
    proteins[key] = Number(row.protein || 0);
    cals[key] = Number(row.cal || 0);
    waters[key] = Number(row.water_intake || 0);
    weights[key] = Number(row.weight || 0);
  });
  return { proteins, cals, waters, weights };
}

exports.getDailyLog = async (req, res) => {
  const { userId, date } = req.params;
  console.log(`[Database] Fetching daily log for User: ${userId}, Date: ${date}`);
  const client = await db.getPool().connect();
  try {
    const profileResult = await client.query('SELECT profile FROM fittrack_profiles WHERE user_id = $1', [userId]);
    const logResult = await client.query(
      'SELECT food_log, water_intake, totals FROM fittrack_daily_logs WHERE user_id = $1 AND log_date = $2',
      [userId, date]
    );
    const weeklyResult = await client.query(
      `SELECT log_date, 
              water_intake,
              COALESCE((totals->>'protein')::numeric, 0) AS protein,
              COALESCE((totals->>'cal')::numeric, 0) AS cal,
              COALESCE((totals->>'weight')::numeric, 0) AS weight
       FROM fittrack_daily_logs
       WHERE user_id = $1 AND log_date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date
       ORDER BY log_date`,
      [userId, date]
    );
    const logRow = logResult.rows[0];
    res.json({
      profile: profileResult.rows[0]?.profile || null,
      log: logRow ? logRow.food_log : null,
      waterIntake: logRow ? logRow.water_intake : null,
      totals: logRow ? logRow.totals : null,
      weeklyData: toWeeklyData(weeklyResult.rows)
    });
  } finally {
    client.release();
  }
};

exports.updateDailyLog = async (req, res) => {
  const { userId, date } = req.params;
  const { profile, log = [], waterIntake = 0, totals = {} } = req.body;
  console.log(`[Database] Updating daily stats for User: ${userId}, Date: ${date}. Log size: ${log.length} items, Water: ${waterIntake} cups`);
  if (!profile) {
    res.status(400).json({ error: 'profile is required' });
    return;
  }

  const client = await db.getPool().connect();
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
};

exports.getHistory = async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 30), 365);
  const { userId } = req.params;
  console.log(`[Database] Fetching history for User: ${userId} (Limit: ${limit} days)`);
  const result = await db.getPool().query(
    `SELECT log_date, food_log, water_intake, totals, updated_at
     FROM fittrack_daily_logs
     WHERE user_id = $1
     ORDER BY log_date DESC
     LIMIT $2`,
    [userId, limit]
  );
  res.json({ days: result.rows });
};
