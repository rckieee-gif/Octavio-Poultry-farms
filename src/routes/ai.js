const express = require('express');
const { pool, getDefaultFarmId } = require('../db');
const { authenticate } = require('../middleware/auth');
const { hasMinimumRole } = require('../middleware/roles');
const { createFlockOpsReply } = require('../../lib/flockOpsAi');

const router = express.Router();

router.post('/flockops-chat', authenticate, async (req, res, next) => {
  const { message, chatHistory, context } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const farmId = req.user.farm_id || await getDefaultFarmId();
    const userRole = req.user.role;
    
    const permissions = {
      canEnterDaily: hasMinimumRole(userRole, 'DataEntry'),
      canViewFinancial: hasMinimumRole(userRole, 'OperationManager'),
      canManageOperations: hasMinimumRole(userRole, 'OperationManager'),
      allowedScreens: [
        'today',
        'dashboard',
        'batches',
        'dailyLog',
        'paySummary',
        'inventory',
        'analytics',
        'settings',
        ...(hasMinimumRole(userRole, 'OperationManager') ? ['employees', 'ledger', 'harvest', 'statement'] : []),
      ]
    };

    const result = await createFlockOpsReply({
      message,
      chatHistory,
      context,
      user: {
        id: req.user.id,
        email: req.user.email,
        username: req.user.username,
        role: userRole,
      },
      permissions,
      farmId,
      db: pool,
    });
    res.json({ reply: result.reply });
  } catch (err) {
    console.error('Failed to run flockops ai chat:', err);
    const customError = new Error('AI processing failed');
    customError.status = 500;
    next(customError);
  }
});

module.exports = router;
