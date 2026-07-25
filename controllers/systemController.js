const env = require('../config/env');
const db = require('../config/db');

exports.getHealth = async (req, res) => {
  if (!db.isDbAvailable() || !db.getPool()) {
    return res.json({ ok: false, db: false });
  }
  try {
    await db.getPool().query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (err) {
    res.json({ ok: true, db: false });
  }
};

exports.getConfig = (req, res) => {
  const geminiEnabled = !!env.GEMINI_API_KEY;
  res.json({
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    scanner_enabled: geminiEnabled,
    gemini_key_hint: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.substring(0, 6) + '...' : 'NOT SET'
  });
};
