require('dotenv').config();

const app = require('./src/app');

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const keepAliveUrl = process.env.KEEP_ALIVE_URL;
const keepAliveIntervalMinutes = Number(process.env.KEEP_ALIVE_INTERVAL_MINUTES || 14);

if (keepAliveUrl && keepAliveIntervalMinutes > 0) {
  const keepAliveIntervalMs = keepAliveIntervalMinutes * 60 * 1000;

  setInterval(async () => {
    try {
      const response = await fetch(keepAliveUrl);
      console.log(`Keep-alive ping ${response.status} -> ${keepAliveUrl}`);
    } catch (err) {
      console.error(`Keep-alive ping failed: ${err.message}`);
    }
  }, keepAliveIntervalMs);

  console.log(`Keep-alive enabled every ${keepAliveIntervalMinutes} minutes.`);
}

module.exports = server;
