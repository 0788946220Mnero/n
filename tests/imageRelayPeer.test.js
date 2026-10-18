/**
 * نفق سيرفر ميرو: المزامنة بين أجهزة الصور في أماكن مختلفة، والفيديو بـ Range من ذاكرة السيرفر،
 * و«مزامنة الآن» من لوحة التحكم — بأجهزة وهمية تتصل بالنفق الحقيقي (WebSocket).
 *   node --test tests/imageRelayPeer.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

const ImageCloud = require('../models/ImageCloud');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SECRET = { A: 'proof-A-' + 'a'.repeat(24), B: 'proof-B-' + 'b'.repeat(24), OLD: 'proof-O-' + 'c'.repeat(24) };
let DOC = {
  key: 'main',
  nodes: [
    { nodeId: 'pos-a', name: 'كاشير المطعم', kind: 'pos', proofHash: sha(SECRET.A), lastSeen: new Date() },
    { nodeId: 'img-b', name: 'Mero Server — المكتب', kind: 'server', proofHash: sha(SECRET.B), lastSeen: new Date() },
    { nodeId: 'pos-old', name: 'جهاز قديم', kind: 'pos', proofHash: sha(SECRET.OLD), lastSeen: new Date(Date.now() - 864e5) },
  ],
};
const clone = (v) => JSON.parse(JSON.stringify(v));
ImageCloud.findOne = () => ({ select() { return this; }, lean: async () => clone(DOC) });
const users = { ADMIN: { _id: 'u1', name: 'مروان', role: 'admin', permissions: [] }, CASHIER: { _id: 'u2', name: 'سامي', role: 'cashier', permissions: [] } };
require.cache[require.resolve('../middlewares/auth')] = { exports: {
  protect: (req, res, next) => { const t = String(req.headers.authorization || '').replace('Bearer ', ''); if (!users[t]) return res.status(401).json({}); req.user = users[t]; next(); },
} };
const relay = require('../services/imageRelayService');

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-cloud', require('../routes/imageCloudRoutes'));
  server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => (req.url.split('?')[0] === relay.WS_PATH ? relay.handleUpgrade(req, socket, head) : socket.destroy()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { relay.reset(); server.close(); });

/** جهاز وهمي: يتصل بالنفق بسرّه، ويرد على كل طلب بالدالة handler(req) ← { status, headers, body }. */
function fakeNode(nodeId, secret, handler) {
  const seen = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}${relay.WS_PATH}`);
  let pending = null;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', nodeId, proof: secret })));
  ws.on('message', (data, isBinary) => {
    const reply = (m, body) => {
      seen.push({ ...m, body });
      const out = handler({ ...m, body }) || { status: 404, headers: {}, body: Buffer.alloc(0) };
      const b = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body || '');
      ws.send(JSON.stringify({ type: 'res', id: m.id, status: out.status, headers: out.headers || {}, size: b.length }));
      if (b.length) ws.send(Buffer.concat([Buffer.from(m.id, 'latin1'), b]), { binary: true });
    };
    if (isBinary) { if (pending) { const m = pending; pending = null; reply(m, Buffer.from(data).subarray(16)); } return; }
    const m = JSON.parse(String(data));
    if (m.type !== 'req') return;
    if (m.size > 0) pending = m; else reply(m, Buffer.alloc(0));
  });
  return { ws, seen, ready: new Promise((r) => { const iv = setInterval(() => { if (relay.isConnected(nodeId)) { clearInterval(iv); r(); } }, 20); }) };
}

test('المزامنة بين جهازين عبر السيرفر: الطلب يصل كما هو مع توقيعه، والرد يعود كما هو', async () => {
  const b = fakeNode('img-b', SECRET.B, (req) => {
    if (req.path === '/internal/sync/vv') return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"pos-a":3}' };
    if (req.path === '/internal/sync/events') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: 'ack', vv: { 'pos-a': 5 }, echo: req.body.length }) };
    if (req.path.startsWith('/internal/sync/blobs/')) return { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-3/10' }, body: Buffer.from('ABCD') };
    return null;
  });
  await b.ready;
  const H = { 'X-Relay-Node': 'pos-a', 'X-Relay-Proof': SECRET.A, 'X-Sync-Node': 'pos-a', 'X-Sync-Ts': '1', 'X-Sync-Nonce': 'n', 'X-Sync-Sig': 'sig', 'X-Sync-Proto': '1' };
  const vv = await fetch(`${base}/api/image-cloud/relay/peer/img-b/internal/sync/vv`, { headers: H });
  assert.equal(vv.status, 200); assert.deepEqual(await vv.json(), { 'pos-a': 3 });
  const fwd = b.seen.find((s) => s.path === '/internal/sync/vv');
  assert.equal(fwd.headers['x-sync-sig'], 'sig', 'توقيع HMAC يصل للجهاز الآخر ليتحقق منه');
  assert.ok(!fwd.headers['x-relay-proof'], 'سرّ الجهاز المرسِل لا يُمرَّر للجهاز الآخر');

  const events = Buffer.from(JSON.stringify({ t: 'events', events: [{ origin: 'pos-a', seq: 4 }, { origin: 'pos-a', seq: 5 }] }));
  const ev = await fetch(`${base}/api/image-cloud/relay/peer/img-b/internal/sync/events`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/vnd.mero-sync+json' }, body: events });
  const ej = await ev.json();
  assert.equal(ev.status, 200); assert.equal(ej.vv['pos-a'], 5); assert.equal(ej.echo, events.length, 'الجسم يصل كما هو بايتاً ببايت');

  const blob = await fetch(`${base}/api/image-cloud/relay/peer/img-b/internal/sync/blobs/${'a'.repeat(64)}`, { headers: { ...H, Range: 'bytes=0-3' } });
  assert.equal(blob.status, 206); assert.equal(blob.headers.get('content-range'), 'bytes 0-3/10'); assert.equal(await blob.text(), 'ABCD');
  assert.equal(b.seen.find((s) => s.path.startsWith('/internal/sync/blobs/')).headers.range, 'bytes=0-3', 'Range يصل (أجزاء 8 ميغابايت)');
  b.ws.close();
});

test('حماية المزامنة عبر السيرفر', async () => {
  const b = fakeNode('img-b', SECRET.B, () => ({ status: 200, headers: {}, body: '{}' }));
  await b.ready;
  const get = (p, h) => fetch(`${base}/api/image-cloud/relay/peer/${p}`, { headers: h });
  assert.equal((await get('img-b/internal/sync/vv', { 'X-Relay-Node': 'pos-a', 'X-Relay-Proof': 'wrong-proof-xxxxxxxxxxxxxxx' })).status, 401, 'سرّ خاطئ');
  assert.equal((await get('img-b/internal/sync/vv', {})).status, 401, 'بلا هوية');
  assert.equal((await get('img-b/internal/sync/vv', { 'X-Relay-Node': 'img-b', 'X-Relay-Proof': SECRET.B })).status, 400, 'الجهاز مع نفسه');
  assert.equal((await get('pos-old/internal/sync/vv', { 'X-Relay-Node': 'pos-a', 'X-Relay-Proof': SECRET.A })).status, 503, 'الهدف غير متصل');
  assert.equal((await get('img-b/api/v1/local/peers', { 'X-Relay-Node': 'pos-a', 'X-Relay-Proof': SECRET.A })).status, 404, 'مسار غير المزامنة لا يمر');
  assert.equal((await get('img-b/internal/sync/events', { 'X-Relay-Node': 'pos-a', 'X-Relay-Proof': SECRET.A })).status, 405, 'الأحداث POST فقط');
  assert.equal(b.seen.length, 0, 'لا شيء من هذه وصل للجهاز');
  b.ws.close();
});

test('الفيديو عبر النفق: يُجلب مرة واحدة، و Range يُخدم من ذاكرة السيرفر', async () => {
  relay.clearCache();
  const video = crypto.randomBytes(5000);
  const a = fakeNode('pos-a', SECRET.A, (req) => (req.path === '/media/VID1/large'
    ? { status: 200, headers: { 'content-type': 'video/mp4', etag: '"v1"' }, body: video } : null));
  await a.ready;
  const url = `${base}/api/image-cloud/relay/media/VID1/large`;
  const r1 = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), `bytes 100-199/${video.length}`);
  assert.ok(Buffer.from(await r1.arrayBuffer()).equals(video.subarray(100, 200)));
  const r2 = await fetch(url, { headers: { Range: 'bytes=4900-' } });
  assert.equal(r2.status, 206); assert.equal(r2.headers.get('x-image-relay'), 'hit');
  assert.ok(Buffer.from(await r2.arrayBuffer()).equals(video.subarray(4900)));
  const r3 = await fetch(url);
  assert.equal(r3.status, 200); assert.equal(r3.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await r3.arrayBuffer()).equals(video));
  assert.equal((await fetch(url, { headers: { Range: 'bytes=9999-' } })).status, 416);
  assert.equal(a.seen.filter((s) => s.path === '/media/VID1/large').length, 1, 'الجهاز سُئل مرة واحدة فقط');
  assert.ok(!a.seen[0].headers.range, 'السيرفر جلب الملف كاملاً (لا Range للجهاز)');
  assert.ok(relay.cacheStats().video.bytes >= video.length, 'في ذاكرة الفيديو المنفصلة');
  a.ws.close();
});

test('«مزامنة الآن»: لمدير النظام، تسأل كل جهاز متصل وتعرض حالته وأسماء الأجهزة', async () => {
  const a = fakeNode('pos-a', SECRET.A, (req) => (req.path === '/relay/sync-now' ? { status: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node: 'pos-a', images: 12, missingFiles: 0, fetching: 0, error: null, peers: [{ nodeId: 'img-b', direct: false, relay: true, pendingEvents: 0, sent: 4, error: null }] }) } : null));
  const b = fakeNode('img-b', SECRET.B, () => ({ status: 404, headers: {}, body: '' })); // برنامج قديم
  await Promise.all([a.ready, b.ready]);
  const call = (t) => fetch(`${base}/api/image-cloud/sync-now`, { method: 'POST', headers: t ? { Authorization: `Bearer ${t}` } : {} });
  assert.equal((await call()).status, 401);
  assert.equal((await call('CASHIER')).status, 403);
  const r = await call('ADMIN'); const j = await r.json();
  assert.equal(r.status, 200);
  const A = j.nodes.find((n) => n.nodeId === 'pos-a'); const Bn = j.nodes.find((n) => n.nodeId === 'img-b'); const O = j.nodes.find((n) => n.nodeId === 'pos-old');
  assert.equal(A.images, 12); assert.equal(A.peers[0].name, 'Mero Server — المكتب'); assert.equal(A.peers[0].sent, 4);
  assert.match(Bn.error, /قديم — حدّثه/);
  assert.equal(O.connected, false); assert.equal(O.name, 'جهاز قديم');
  a.ws.close(); b.ws.close();
});
