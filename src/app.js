const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');

const VALID_ID = /^[A-Za-z0-9_-]{16,128}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function validPng(image) {
  return Buffer.isBuffer(image) && image.length >= 57
    && image.subarray(0, 8).equals(PNG_SIGNATURE)
    && image.readUInt32BE(8) === 13 && image.toString('ascii', 12, 16) === 'IHDR'
    && image.readUInt32BE(16) > 0 && image.readUInt32BE(16) <= 4096
    && image.readUInt32BE(20) > 0 && image.readUInt32BE(20) <= 4096
    && image.subarray(-12).equals(PNG_END);
}

function createApp({ store, uploadApiKey, publicBaseUrl, isReady = () => true, logger = console }) {
  if (!uploadApiKey || uploadApiKey.length < 32) throw new Error('UPLOAD_API_KEY must contain at least 32 characters.');
  const publicUrl = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_BASE_URL must be the public HTTP(S) origin of this service.');
  }
  const expectedKey = createHash('sha256').update(`Bearer ${uploadApiKey}`).digest();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get('/health', (_req, res) => {
    const ready = isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
  });
  app.use('/images', (_req, res, next) => {
    if (!isReady()) return res.status(503).json({ error: 'Image storage is temporarily unavailable.' });
    next();
  });
  app.param('id', (_req, res, next, id) => {
    if (!VALID_ID.test(id)) return res.status(400).json({ error: 'Invalid artwork ID. Use 16–128 letters, numbers, underscores or hyphens.' });
    next();
  });
  const authorize = (req, res, next) => {
    const supplied = createHash('sha256').update(req.get('authorization') || '').digest();
    if (!timingSafeEqual(expectedKey, supplied)) return res.status(401).json({ error: 'Unauthorized upload.' });
    next();
  };
  app.put('/images/:id', authorize, express.raw({ type: 'image/png', limit: '8mb', inflate: false }), async (req, res) => {
    if (!req.is('image/png')) return res.status(415).json({ error: 'Send the PNG bytes with Content-Type: image/png.' });
    if (!validPng(req.body)) return res.status(400).json({ error: 'Send a valid PNG image, no larger than 4096 × 4096.' });
    const etag = `"${createHash('sha256').update(req.body).digest('hex')}"`;
    const created = await store.put(req.params.id, req.body, etag);
    const url = new URL(`/images/${req.params.id}`, publicUrl).href;
    res.status(created ? 201 : 200).location(url).json({ id: req.params.id, url });
  });
  app.get('/images/:id', async (req, res) => {
    const artwork = await store.get(req.params.id);
    if (!artwork) return res.status(404).json({ error: 'Artwork not found.' });
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      ETag: artwork.etag,
      'Content-Disposition': `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="jkit-artwork-${req.params.id}.png"`,
    });
    res.send(artwork.image);
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Image exceeds the 8 MB limit.' });
    if (error.status === 415) return res.status(415).json({ error: 'Unsupported content encoding.' });
    logger.error('Artwork request failed:', error.message);
    res.status(500).json({ error: 'Unable to process the artwork. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
