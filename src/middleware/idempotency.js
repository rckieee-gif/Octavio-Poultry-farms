const { pool } = require('../db');

/**
 * Express middleware to handle idempotency for offline queued requests.
 * Uses the 'X-Sync-Queue-Id' header sent by the client.
 */
async function idempotencyMiddleware(req, res, next) {
  const syncQueueId = req.header('x-sync-queue-id');

  // Only process mutating requests that have the X-Sync-Queue-Id header
  if (!syncQueueId || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  try {
    // 1. Check database for existing key
    const existing = await pool.query(
      'SELECT status_code, response_body, created_at FROM idempotency_keys WHERE key = $1',
      [syncQueueId]
    );

    if (existing.rowCount > 0) {
      const { status_code, response_body, created_at } = existing.rows[0];

      if (status_code > 0) {
        // Already processed successfully or with a client error, return cached response
        console.log(`Idempotency hit: Returning cached response for key ${syncQueueId}`);
        try {
          const parsed = JSON.parse(response_body);
          return res.status(status_code).json(parsed);
        } catch (e) {
          return res.status(status_code).send(response_body);
        }
      } else {
        // status_code is 0 (processing).
        // If it was created more than 30 seconds ago, assume the previous attempt crashed/timed out and clean it up.
        const ageMs = Date.now() - new Date(created_at).getTime();
        if (ageMs > 30000) {
          console.warn(`Idempotency key ${syncQueueId} was stuck in processing state for ${ageMs}ms. Cleaning up to allow retry.`);
          await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [syncQueueId]);
        } else {
          // It is actively processing
          return res.status(409).json({ error: 'Request is already being processed.' });
        }
      }
    }

    // 2. Reserve the key in processing state
    try {
      await pool.query(
        "INSERT INTO idempotency_keys (key, status_code, response_body) VALUES ($1, 0, 'processing')",
        [syncQueueId]
      );
    } catch (err) {
      // If unique constraint violation, someone else inserted it between the SELECT and INSERT.
      if (err.code === '23505') { // PostgreSQL unique violation code
        const doubleCheck = await pool.query(
          'SELECT status_code, response_body FROM idempotency_keys WHERE key = $1',
          [syncQueueId]
        );
        if (doubleCheck.rowCount > 0 && doubleCheck.rows[0].status_code > 0) {
          const { status_code, response_body } = doubleCheck.rows[0];
          try {
            return res.status(status_code).json(JSON.parse(response_body));
          } catch (e) {
            return res.status(status_code).send(response_body);
          }
        }
        return res.status(409).json({ error: 'Request is already being processed.' });
      }
      throw err;
    }

    // Flag to track if we've updated the database for this request
    let dbUpdated = false;

    // 3. Clean up helper
    const cleanupStuckKey = async () => {
      if (!dbUpdated) {
        dbUpdated = true;
        try {
          await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [syncQueueId]);
        } catch (err) {
          console.error(`Failed to clean up stuck idempotency key ${syncQueueId}:`, err);
        }
      }
    };

    // Listen to close event in case of client disconnect or unhandled crashes
    res.on('close', async () => {
      if (!res.writableEnded) {
        await cleanupStuckKey();
      }
    });

    // Helper to perform the DB write
    const handleResponse = async (body) => {
      if (dbUpdated) return;
      dbUpdated = true;

      const statusCode = res.statusCode;
      if (statusCode >= 500) {
        // If it's a server error, delete the key so they can retry
        try {
          await pool.query('DELETE FROM idempotency_keys WHERE key = $1', [syncQueueId]);
        } catch (err) {
          console.error(`Failed to delete failed idempotency key ${syncQueueId}:`, err);
        }
      } else {
        // Update with final response (await to ensure it commits before returning HTTP response)
        try {
          await pool.query(
            'UPDATE idempotency_keys SET status_code = $1, response_body = $2 WHERE key = $3',
            [statusCode, body || '', syncQueueId]
          );
        } catch (err) {
          console.error(`Failed to update idempotency key ${syncQueueId}:`, err);
        }
      }
    };

    // 4. Intercept res.send and res.end
    const originalSend = res.send;
    res.send = async function (body) {
      res.send = originalSend;
      await handleResponse(body);
      return originalSend.call(this, body);
    };

    const originalEnd = res.end;
    res.end = async function (chunk, encoding, cb) {
      res.end = originalEnd;
      let body = '';
      if (chunk) {
        if (typeof chunk === 'string') {
          body = chunk;
        } else if (Buffer.isBuffer(chunk)) {
          body = chunk.toString('utf8');
        }
      }
      await handleResponse(body);
      return originalEnd.call(this, chunk, encoding, cb);
    };

    next();
  } catch (error) {
    console.error('Error in idempotency middleware:', error);
    next(error);
  }
}

module.exports = idempotencyMiddleware;
