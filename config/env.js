const fs = require('fs');
const path = require('path');

// Manually load .env variables if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  try {
    const envFile = fs.readFileSync(envPath, 'utf-8');
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
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    });
  } catch (err) {
    console.error('Failed to read .env file:', err);
  }
}

// Export some common configuration constants
module.exports = {
  PORT: process.env.PORT || 3000,
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/fittrack',
  GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || null,
  PGSSLMODE: process.env.PGSSLMODE
};
