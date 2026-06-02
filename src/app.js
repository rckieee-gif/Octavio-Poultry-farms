const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const { router: batchesRouter, getCurrentBatchSnapshot } = require('./routes/batches');
const transactionsRouter = require('./routes/transactions');
const inventoryRouter = require('./routes/inventory');
const employeesRouter = require('./routes/employees');
const logsRouter = require('./routes/logs');
const aiRouter = require('./routes/ai');
const settingsRouter = require('./routes/settings');
const masterDataRouter = require('./routes/masterData');
const idempotencyMiddleware = require('./middleware/idempotency');

const app = express();

// 1. CORS with Restricted Origin Matching
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  throw new Error('CORS_ORIGINS must be set in production.');
}

app.use(cors({
  origin(origin, callback) {
    // If no allowed origins are defined (e.g. local development), or if the origin matches, permit it.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// 2. Helmet Security Headers (Content Security Policy, XSS Protection, etc.)
app.use(helmet());

// 3. Global Rate Limiting for API routes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});
app.use('/api', limiter);

// 4. Reduced JSON body limit
app.use(express.json({ limit: '2mb' }));

// Idempotency check for queued offline mutations
app.use('/api', idempotencyMiddleware);

// 5. Register Domain Routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/logs', logsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api', masterDataRouter);

// Dual mount transactions / employees since they have nested /api/batches/... paths
app.use('/api/transactions', transactionsRouter);
app.use('/api', transactionsRouter);
app.use('/api', employeesRouter);
app.use('/api', aiRouter);

// 6. Public Batch Snapshot Route
app.get('/api/public/current-batch', async (req, res, next) => {
  try {
    const snapshot = await getCurrentBatchSnapshot();
    if (!snapshot) {
      return res.status(404).json({ error: 'No current batch found.' });
    }
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// 7. API Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'octavio-farm-api' });
});

// 8. Global Error Handler
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: err.message });
  }
  console.error('Unhandled server error:', err);

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error',
  });
});

module.exports = app;
