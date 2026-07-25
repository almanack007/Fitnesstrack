const db = require('../config/db');

exports.deleteUser = async (req, res) => {
  const { userId } = req.params;
  console.log(`[Database] Deleting account and all logs for User: ${userId}`);
  await db.getPool().query('DELETE FROM fittrack_profiles WHERE user_id = $1', [userId]);
  res.json({ ok: true });
};
