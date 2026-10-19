const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const Artwork = require('../src/models/Artwork');

const KEY = 'test-upload-secret-key-with-more-than-32-characters';
const ID = 'game-artwork-token-123456789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhFoAAAAASUVORK5CYII=', 'base64');
let server, base, ready, records, fail;

beforeEach(async () => {
  ready = true;
  fail = false;
  records = new Map();
  const store = {
    async put(id, image, etag) {
      if (fail) throw new Error('private database information');
      const created = !records.has(id);
      records.set(id, { image: Buffer.from(image), etag });
      return created;
    },
    async get(id) {
      if (fail) throw new Error('private database information');
      return records.get(id);
    },
  };
  server = createApp({ store, uploadApiKey: KEY, publicBaseUrl: 'https://art.example.com',
    isReady: () => ready, logger: { error() {} } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
});
function upload({ id = ID, image = PNG, key = KEY, type = 'image/png' } = {}) {
  return fetch(`${base}/images/${id}`, { method: 'PUT', headers: {
    Authorization: `Bearer ${key}`, 'Content-Type': type,
  }, body: image });
}

test('upload returns a public QR URL and scanning it serves exactly the PNG', async () => {
  const response = await upload();
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: ID, url: `https://art.example.com/images/${ID}` });
  const image = await fetch(`${base}/images/${ID}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-disposition'), /^inline;/);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
});
test('repeated uploads update the same ID and the download flag sends an attachment', async () => {
  await upload();
  assert.equal((await upload()).status, 200);
  assert.equal(records.size, 1);
  const response = await fetch(`${base}/images/${ID}?download=true`);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
});
test('upload requires the private key but reading does not', async () => {
  assert.equal((await upload({ key: 'incorrect' })).status, 401);
  assert.equal(records.size, 0);
  assert.equal((await fetch(`${base}/images/${ID}`)).status, 404);
});
test('invalid IDs, file types, broken PNGs, and oversized payloads are rejected', async () => {
  assert.equal((await upload({ id: 'short' })).status, 400);
  assert.equal((await upload({ type: 'text/html' })).status, 415);
  assert.equal((await upload({ image: Buffer.from('not an image') })).status, 400);
  assert.equal((await upload({ image: Buffer.alloc(8 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(records.size, 0);
});
test('health and image requests report disconnected database state', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  ready = false;
  assert.equal((await fetch(`${base}/health`)).status, 503);
  assert.equal((await fetch(`${base}/images/${ID}`)).status, 503);
});
test('repeat image requests can use conditional caching and HEAD', async () => {
  await upload();
  const image = await fetch(`${base}/images/${ID}`);
  const cached = await fetch(`${base}/images/${ID}`, { cache: 'force-cache', headers: { 'If-None-Match': image.headers.get('etag') } });
  assert.equal(cached.status, 304);
  const head = await fetch(`${base}/images/${ID}`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-type'), 'image/png');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});
test('database errors return a safe error instead of exposing internals', async () => {
  fail = true;
  const response = await upload();
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private database information/);
});
test('Mongoose stores PNG bytes as a Buffer under the artwork token', async () => {
  const doc = new Artwork({ _id: ID, image: PNG, etag: 'hash' });
  await doc.validate();
  assert.deepEqual(Buffer.from(doc.image), PNG);
  assert.equal(doc._id, ID);
});
