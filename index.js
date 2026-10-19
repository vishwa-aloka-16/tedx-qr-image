const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const mongoose = require('mongoose');
const { createApp } = require('./src/app');
const store = require('./src/store');

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in the service environment.');
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const app = createApp({ store, uploadApiKey: process.env.UPLOAD_API_KEY,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
    isReady: () => mongoose.connection.readyState === 1 });
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongoose.connection.db.admin().ping();
  console.log('MongoDB connected successfully. Database ping: OK.');
  const server = app.listen(port, '0.0.0.0', () => console.log(`Artwork sharing service listening on port ${port}`));
  server.on('error', async (error) => {
    console.error('HTTP server failed:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await mongoose.disconnect();
      clearTimeout(timeout);
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

start().catch((error) => {
  console.error('Artwork sharing service could not start:', error.message);
  process.exit(1);
});
