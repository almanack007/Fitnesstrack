const express = require('express');
const router = express.Router();

const db = require('../config/db');
const systemController = require('../controllers/systemController');
const scanController = require('../controllers/scanController');
const logController = require('../controllers/logController');
const userController = require('../controllers/userController');

// System endpoints
router.get('/health', systemController.getHealth);
router.get('/config', systemController.getConfig);

// Gemini AI endpoints
router.get('/test-gemini', scanController.testGemini);
router.post('/scan', scanController.scanFood);
router.post('/coach/chat', scanController.chatCoach);

// Daily Logs (Requires DB)
router.get('/daily/:userId/:date', db.requireDb, logController.getDailyLog);
router.put('/daily/:userId/:date', db.requireDb, logController.updateDailyLog);

// History (Requires DB)
router.get('/history/:userId', db.requireDb, logController.getHistory);

// User Management (Requires DB)
router.delete('/users/:userId', db.requireDb, userController.deleteUser);

module.exports = router;
