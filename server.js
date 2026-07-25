const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const db = require('./config/db');
const apiRoutes = require('./routes/apiRoutes');

console.log('Using DATABASE_URL:', env.DATABASE_URL);

if (env.GEMINI_API_KEY) {
  console.log(`[Gemini] REST API enabled. Key prefix: ${env.GEMINI_API_KEY.substring(0, 8)}...`);
} else {
  console.log('[Gemini] No GEMINI_API_KEY configured — scanner will be unavailable.');
}

const app = express();

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

// Mount API routes
app.use('/api', apiRoutes);

// Catch-all route to serve the frontend index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Global error handler
app.use((error, req, res, next) => {
  console.error(`[Error] Unhandled error during request ${req.method} ${req.originalUrl}:`, error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server and initialize database if possible
async function startServer() {
  if (db.getPool()) {
    try {
      await db.initDb();
      db.setDbAvailable(true);
      console.log('Database connected and tables initialized.');
    } catch (error) {
      console.warn('Database not available — running in offline mode.');
      console.warn('Reason:', error.message || error);
      console.error('Full Database Error Details:', error);
      db.setDbAvailable(false);
    }
  }

  app.listen(env.PORT, () => {
    console.log(`FitTrack Pro running at http://localhost:${env.PORT}`);
    if (!db.isDbAvailable()) {
      console.log('Note: Running without database. All data is stored in the browser\'s localStorage.');
    }
  });
}

startServer();
