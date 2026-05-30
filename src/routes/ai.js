const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate } = require('../middleware/auth');
const { createFlockOpsReply } = require('../../lib/flockOpsAi');

const router = express.Router();

router.post('/flockops-chat', authenticate, async (req, res, next) => {
  const { message, chatHistory } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const reply = await createFlockOpsReply({
      message,
      chatHistory,
      farmId,
      db: pool,
    });
    res.json({ reply });
  } catch (err) {
    console.error('Failed to run flockops ai chat:', err);
    const customError = new Error('AI processing failed');
    customError.status = 500;
    next(customError);
  }
});

module.exports = router;
