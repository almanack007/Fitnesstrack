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

// Use Gemini REST API directly via fetch — avoids SDK network layer issues on some hosts
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const geminiEnabled = !!GEMINI_API_KEY;

if (geminiEnabled) {
  console.log(`[Gemini] REST API enabled. Key prefix: ${GEMINI_API_KEY.substring(0, 8)}...`);
} else {
  console.log('[Gemini] No GEMINI_API_KEY configured — scanner will be unavailable.');
}

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
app.use(express.json({ limit: '10mb' }));
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
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    scanner_enabled: geminiEnabled,
    gemini_key_hint: GEMINI_API_KEY ? GEMINI_API_KEY.substring(0, 6) + '...' : 'NOT SET'
  });
});

app.post('/api/scan', async (req, res) => {
  const { image } = req.body;

  console.log(`[LensPro /api/scan] Request received. Image present: ${!!image}, length: ${image ? image.length : 0} chars`);

  if (!image) {
    return res.status(400).json({ error: 'Image data is required' });
  }

  if (!geminiEnabled) {
    console.log('[LensPro /api/scan] No API key — returning scanner_unavailable.');
    return res.json({ scanner_unavailable: true, message: 'Gemini API key not configured on server.' });
  }

  try {
    const imgMatch = image.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
    if (!imgMatch) {
      return res.status(400).json({ error: 'Invalid base64 image format' });
    }
    const mimeType = `image/${imgMatch[1]}`;
    const base64Data = imgMatch[2];

    console.log(`[LensPro /api/scan] Image OK — mime: ${mimeType}, size: ~${Math.round(base64Data.length * 0.75 / 1024)}KB`);

    // Google Lens-style prompt: free identification + database mapping + dynamic macro estimation
    const prompt = `You are a world-class food recognition AI with the same visual accuracy as Google Lens.
Analyze this image carefully and thoroughly.

STEP 1 — IDENTIFY: Identify the food name as specifically and accurately as possible using your complete visual and internet knowledge (colors, textures, ingredients, cooking style, plating context).
Examples of good answers: "white basmati rice", "banana", "butter chicken curry", "scrambled eggs", "aloo paratha", "masala dosa".

STEP 2 — DECIDE: Is there actual VISIBLE, OPEN food in the image?
Rules:
- Sealed/closed container, jar, tin, bottle, or packet = NOT FOOD (you cannot see the food)
- Non-food object (electronics, furniture, fabric, body parts, hands, feet, floor, wall, screen, paper) = NOT FOOD
- Blurry, dark, or unidentifiable content = NOT FOOD
- Clearly visible prepared, raw, or plated food = FOOD

STEP 3 — MATCH: If FOOD, check if it matches any item in our database of tracked foods:
["Daal Chawal","Paneer Butter Masala","Butter Chicken","Chana Masala","Chicken Biryani","Veg Biryani","Choole Bhature","Dal Makhani","Palak Paneer","Rajma Chawal","Khichdi","Muttar Paneer","Aloo Gobi","Bhindi Masala","Basmati Rice Cooked","Brown Rice Cooked","Roti / Chapati","Tandoori Roti","Plain Paratha","Aloo Paratha","Butter Naan","Garlic Naan","Puri","Bhatura","Poha","Upma","Idli with Sambar","Masala Dosa","Moong Dal Cooked","Masoor Dal Cooked","Soya Chunks Cooked","Paneer Bhurji","Tandoori Chicken","Fish Tikka","Chicken Tikka","Egg Bhurji","Boiled Egg","Chicken Breast","Mutton Curry","Paneer raw","Whole Milk Curd / Dahi","Cow Milk","Buffalo Milk","Ghee","Sweet Lassi","Chaas / Buttermilk","Samosa","Dhokla","Medu Vada","Pani Puri","Bhel Puri","Pav Bhaji","Vada Pav","Roasted Chana","Roasted Makhana","Gulab Jamun","Rasgulla","Gajar ka Halwa","Jalebi","Besan Ladoo","Kheer","Masala Chai","Filter Coffee","Tender Coconut Water","Sugarcane Juice","Nimbu Pani","Banana","Apple","Mango","Orange","Papaya"]

If it is a close visual match, set "match" to the exact string from the list above. If it does not match any item closely, set "match" to "" (empty string) and we will use the estimated macros.

STEP 4 — MACROS: If FOOD, estimate the macronutrient profile per 100g (or per piece/cup if more natural for fruits/eggs/beverages) based on standard USDA/nutritional databases.
Fields in estimated_macros:
- cal: calories (kcal)
- protein: protein in grams
- carbs: total carbohydrates in grams
- fat: fat in grams
- unit: serving unit, either "g" (default), "cup" (for beverages/liquids), or "piece" (for fruits, boiled eggs, etc.)
- per: serving size value (100 for "g", 1 for "piece" or "cup")

STEP 5 — CONFIDENCE: Rate 0-100 how confident you are that this is food and that your identification is correct. Be honest.

STEP 6 — REJECTION MESSAGE: If NOT FOOD, write one short friendly sentence saying what you actually see (e.g. "Looks like a laptop screen — point the camera at your meal instead.").

Return ONLY raw JSON (no markdown, no backticks, no extra text):
{
  "is_food": true or false,
  "identified_as": "specific food name if food, otherwise empty string",
  "match": "exact name from database list if matched, otherwise empty string",
  "confidence": 0-100,
  "rejection_message": "friendly message if not food, otherwise empty string",
  "estimated_macros": {
    "cal": 0,
    "protein": 0.0,
    "carbs": 0.0,
    "fat": 0.0,
    "unit": "g",
    "per": 100
  }
}`;

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType, data: base64Data } }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 600,
        responseMimeType: 'application/json'
      }
    };

    console.log('[LensPro /api/scan] Calling Gemini REST API via fetch...');
    const startTime = Date.now();

    const geminiRes = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const elapsed = Date.now() - startTime;
    console.log(`[LensPro /api/scan] Gemini responded in ${elapsed}ms. HTTP status: ${geminiRes.status}`);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('[LensPro /api/scan] Gemini API error response:', errText);
      return res.status(502).json({ error: 'Gemini API returned an error', detail: errText.substring(0, 200) });
    }

    const geminiJson = await geminiRes.json();
    let text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[LensPro /api/scan] Raw Gemini text: "${text}"`);

    // Clean any accidental markdown
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('[LensPro /api/scan] JSON parse failed, using regex extraction. Text was:', text);
      const isFoodMatch = /"is_food"\s*:\s*true/i.test(text);
      const identMatch = text.match(/"identified_as"\s*:\s*"([^"]*)"/); 
      const matchMatch = text.match(/"match"\s*:\s*"([^"]*)"/); 
      const confMatch = text.match(/"confidence"\s*:\s*(\d+)/);
      const rejMatch = text.match(/"rejection_message"\s*:\s*"([^"]*)"/); 
      
      const calMatch = text.match(/"cal"\s*:\s*(\d+)/);
      const protMatch = text.match(/"protein"\s*:\s*([\d.]+)/);
      const carbMatch = text.match(/"carbs"\s*:\s*([\d.]+)/);
      const fatMatch = text.match(/"fat"\s*:\s*([\d.]+)/);
      const unitMatch = text.match(/"unit"\s*:\s*"([^"]*)"/);
      const perMatch = text.match(/"per"\s*:\s*(\d+)/);
      
      parsed = {
        is_food: isFoodMatch,
        identified_as: identMatch ? identMatch[1] : '',
        match: matchMatch ? matchMatch[1] : '',
        confidence: confMatch ? parseInt(confMatch[1], 10) : 0,
        rejection_message: rejMatch ? rejMatch[1] : '',
        estimated_macros: isFoodMatch ? {
          cal: calMatch ? parseInt(calMatch[1], 10) : 0,
          protein: protMatch ? parseFloat(protMatch[1]) : 0,
          carbs: carbMatch ? parseFloat(carbMatch[1]) : 0,
          fat: fatMatch ? parseFloat(fatMatch[1]) : 0,
          unit: unitMatch ? unitMatch[1] : 'g',
          per: perMatch ? parseInt(perMatch[1], 10) : 100
        } : null
      };
    }

    // Confidence gate: < 70 → treat as not_food
    if (parsed.is_food && parsed.confidence < 70) {
      console.log(`[LensPro /api/scan] Confidence ${parsed.confidence} < 70 — downgrading to not_food`);
      parsed.is_food = false;
      parsed.rejection_message = `I can see something but I'm only ${parsed.confidence}% sure it's "${parsed.identified_as || 'food'}". Try a clearer, closer photo with better lighting.`;
      parsed.identified_as = '';
      parsed.match = '';
      parsed.estimated_macros = null;
    }

    console.log(`[LensPro /api/scan] RESULT: is_food=${parsed.is_food}, identified_as="${parsed.identified_as}", match="${parsed.match}", confidence=${parsed.confidence}`);
    res.json(parsed);

  } catch (error) {
    console.error('[LensPro /api/scan] FATAL ERROR:', error.message);
    res.status(500).json({ error: 'AI visual scanning failed', detail: error.message });
  }
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
