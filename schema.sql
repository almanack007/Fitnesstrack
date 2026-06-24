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
