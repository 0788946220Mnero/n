/**
 * الصالة + محطة الطباعة + قسائم الأقسام بلا تكرار:
 *   النادل يفتح طاولة ويرسل جولتين ← كل جولة مهمة طباعة «hall» بأصنافها وحدها (لا تتكرر بإعادة الإرسال)
 *   جهازان على الطاولة نفسها لا يفتحان حسابين · الكاشير يلغي صنفاً وينقل ويقبض ← طلب واحد في جرده
 *   النادل لا يقبض ولا يصل لأي قسم آخر · عدة كاشيرات: أول من يحجز قسائم الطلب يطبعها
 */
process.env.JWT_SECRET = 'hall-secret-hall-secret-hall-secret-01';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Product', 'Category', 'Order', 'Counter', 'PrintJob', 'HallTable', 'HallTab', 'ActivityLog', 'Printer'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

let server; let base; const tok = {}; const P = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* */ }
  return { status: r.status, body: json };
};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/hall', require('../routes/hallRoutes'));
  app.use('/api/orders', require('../routes/orderRoutes'));
  app.use('/api/print-jobs', require('../routes/printJobRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, role] of [['admin', 'admin'], ['cashier', 'cashier'], ['cashier2', 'cashier'], ['waiter', 'waiter'], ['waiter2', 'waiter']]) {
    const u = await M('User').create({ name: { admin: 'مروان', cashier: 'سامي', cashier2: 'رامي', waiter: 'علي', waiter2: 'حسن' }[k], username: k, password: 'secret123', role, isActive: true });
    tok[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  }
  const cat = await M('Category').create({ name: 'شاورما', nameAr: 'شاورما' });
  P.shawarma = await M('Product').create({ name: 'شاورما', nameAr: 'شاورما دجاج', price: 2.5, category: cat._id, addons: [{ name: 'جبنة', price: 0.25 }] });
  P.cola = await M('Product').create({ name: 'كولا', nameAr: 'كولا', price: 0.5, category: cat._id });
  P.off = await M('Product').create({ name: 'منتهي', nameAr: 'منتهي', price: 1, category: cat._id, isAvailable: false });
});
test.after(() => server.close());

test('الطاولات: الإعداد للكاشير فقط، والنادل يراها', async () => {
  assert.equal((await call('POST', '/api/hall/tables', { token: tok.waiter, body: { name: '1' } })).status, 403);
  const r = await call('POST', '/api/hall/tables', { token: tok.cashier, body: { from: 1, to: 6, zone: 'داخلي' } });
  assert.equal(r.status, 201); assert.equal(r.body.created, 6);
  assert.equal((await call('POST', '/api/hall/tables', { token: tok.cashier, body: { from: 1, to: 6, zone: 'داخلي' } })).body.created, 0, 'لا تكرار');
  const t = await call('GET', '/api/hall/tables', { token: tok.waiter });
  assert.equal(t.status, 200);
  assert.equal(t.body.tables.length, 6);
  P.t1 = t.body.tables.find((x) => x.name === '1').id;
  P.t2 = t.body.tables.find((x) => x.name === '2').id;
  assert.equal(t.body.tables[0].tab, null);
});

test('النادل يرسل جولتين: الأسعار من الخادم، وكل جولة تُطبع وحدها على المطبخ', async () => {
  const r1 = await call('POST', `/api/hall/tables/${P.t1}/round`, { token: tok.waiter, body: { guests: 3, clientRef: 'r1', items: [{ product: String(P.shawarma._id), quantity: 2, price: 0.01, addons: [{ name: 'جبنة', price: 9 }] }] } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.tab.items[0].price, 2.75, 'السعر من قاعدة البيانات لا من الجهاز');
  assert.equal(r1.body.tab.total, 5.5);
  assert.equal(r1.body.tab.guests, 3);
  P.tab = r1.body.tab.id;
  // إعادة إرسال الجولة نفسها (شبكة الجوال) لا تضيفها مرتين
  const again = await call('POST', `/api/hall/tables/${P.t1}/round`, { token: tok.waiter, body: { clientRef: 'r1', items: [{ product: String(P.shawarma._id), quantity: 2 }] } });
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true);
  assert.equal(again.body.tab.items.length, 1);
  // نادل آخر يضيف جولة ثانية على الحساب نفسه
  const r2 = await call('POST', `/api/hall/tables/${P.t1}/round`, { token: tok.waiter2, body: { clientRef: 'r2', items: [{ product: String(P.cola._id), quantity: 3 }] } });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.tab.id, P.tab, 'الحساب نفسه');
  assert.equal(r2.body.tab.rounds, 2);
  assert.equal(r2.body.tab.total, 7);
  const jobs = await M('PrintJob').find({ type: 'hall' }).sort({ createdAt: 1 }).lean();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[1].payload.items.map((i) => i.nameAr), ['كولا'], 'الجولة الثانية وحدها');
  assert.equal(jobs[1].payload.tableName, '1');
  assert.equal(jobs[1].payload.round, 2);
  assert.equal((await call('POST', `/api/hall/tables/${P.t2}/round`, { token: tok.waiter, body: { items: [{ product: String(P.off._id) }] } })).status, 400, 'صنف غير متوفر');
});

test('جهازان يفتحان الطاولة الفارغة نفسها معاً ← حساب واحد', async () => {
  const [a, b] = await Promise.all([
    call('POST', `/api/hall/tables/${P.t2}/round`, { token: tok.waiter, body: { clientRef: 'a', items: [{ product: String(P.cola._id) }] } }),
    call('POST', `/api/hall/tables/${P.t2}/round`, { token: tok.waiter2, body: { clientRef: 'b', items: [{ product: String(P.cola._id) }] } }),
  ]);
  const ok = [a, b].filter((x) => x.status === 201);
  assert.ok(ok.length >= 1);
  const tabs = await M('HallTab').find({ table: P.t2, status: 'open' }).lean();
  assert.equal(tabs.length, 1, 'حساب واحد مفتوح للطاولة');
  if (ok.length === 2) assert.equal(a.body.tab.id, b.body.tab.id);
});

test('طلب الحساب، إلغاء صنف (للكاشير)، نقل الطاولة، والقبض', async () => {
  const bill = await call('POST', `/api/hall/tabs/${P.tab}/bill`, { token: tok.waiter });
  assert.equal(bill.status, 200);
  assert.ok(bill.body.tab.billRequestedAt);
  const hb = await M('PrintJob').findOne({ type: 'hallbill' }).lean();
  assert.equal(hb.payload.tab.total, 7);

  const tab = (await call('GET', `/api/hall/tabs/${P.tab}`, { token: tok.waiter })).body.tab;
  const cola = tab.items.find((i) => i.nameAr === 'كولا');
  assert.equal((await call('POST', `/api/hall/tabs/${P.tab}/items/${cola.id}/void`, { token: tok.waiter, body: {} })).status, 403, 'النادل لا يلغي');
  const v = await call('POST', `/api/hall/tabs/${P.tab}/items/${cola.id}/void`, { token: tok.cashier, body: { reason: 'خطأ' } });
  assert.equal(v.status, 200); assert.equal(v.body.tab.total, 5.5);
  const voidJob = await M('PrintJob').findOne({ type: 'hall', 'payload.voided': true }).lean();
  assert.ok(voidJob, 'المطبخ يُبلَّغ بالإلغاء');

  // نقل إلى طاولة مشغولة مرفوض، وإلى فارغة مسموح
  assert.equal((await call('POST', `/api/hall/tabs/${P.tab}/move`, { token: tok.waiter, body: { tableId: P.t2 } })).status, 409);
  const t3 = (await call('GET', '/api/hall/tables', { token: tok.waiter })).body.tables.find((x) => x.name === '3').id;
  const mv = await call('POST', `/api/hall/tabs/${P.tab}/move`, { token: tok.waiter, body: { tableId: t3 } });
  assert.equal(mv.status, 200); assert.equal(mv.body.tab.tableName, '3');
  const tables = (await call('GET', '/api/hall/tables', { token: tok.waiter })).body.tables;
  assert.equal(tables.find((x) => x.name === '1').tab, null, 'الطاولة القديمة فرغت');

  assert.equal((await call('POST', `/api/hall/tabs/${P.tab}/pay`, { token: tok.waiter, body: {} })).status, 403, 'النادل لا يقبض');
  const before = await M('Order').countDocuments({ source: 'hall' });
  assert.equal(before, 0, 'لا شيء في الجرد قبل القبض');
  const [p1, p2] = await Promise.all([
    call('POST', `/api/hall/tabs/${P.tab}/pay`, { token: tok.cashier, body: { paymentMethod: 'card', discount: 0.5 } }),
    call('POST', `/api/hall/tabs/${P.tab}/pay`, { token: tok.cashier2, body: { paymentMethod: 'cash' } }),
  ]);
  const ok = [p1, p2].filter((x) => x.status === 200);
  assert.equal(ok.length, 1, 'قبض واحد فقط');
  const order = ok[0].body.order;
  assert.equal(order.source, 'hall'); assert.equal(order.orderType, 'dinein');
  assert.equal(order.tableName, '3'); assert.equal(order.status, 'delivered');
  assert.ok(order.ticketsAt, 'قسائم المطبخ لا تُعاد عند الإغلاق');
  assert.equal(await M('Order').countDocuments({ source: 'hall' }), 1);
  assert.equal((await call('GET', '/api/hall/tables', { token: tok.waiter })).body.tables.find((x) => x.name === '3').tab, null, 'الطاولة فرغت بعد القبض');
});

test('النادل محصور في الصالة: لا طلبات ولا طابور طباعة', async () => {
  const { protect } = require('../middlewares/auth');
  const app = express(); app.use(express.json());
  app.get('/api/orders', protect, (_req, res) => res.json({ ok: 1 }));
  app.get('/api/print-jobs/pending', protect, (_req, res) => res.json({ ok: 1 }));
  app.get('/api/products', protect, (_req, res) => res.json({ ok: 1 }));
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const get = (u) => fetch(b + u, { headers: { Authorization: `Bearer ${tok.waiter}` } }).then((r) => r.status);
  assert.equal(await get('/api/orders'), 403);
  assert.equal(await get('/api/print-jobs/pending'), 403);
  assert.equal(await get('/api/products'), 200);
  s.close();
});

test('عدة كاشيرات: قسائم الطلب يطبعها أول من يحجزها فقط، ومحطة الطباعة تُرى متصلة', async () => {
  const o = await M('Order').create({ orderNumber: 'T-1', total: 1, items: [], source: 'pos', status: 'preparing' });
  const [a, b] = await Promise.all([
    call('POST', `/api/orders/${o._id}/tickets-claim`, { token: tok.cashier, body: { station: 'كاشير 1' } }),
    call('POST', `/api/orders/${o._id}/tickets-claim`, { token: tok.cashier2, body: { station: 'كاشير 2' } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.match(loser.body.message, /كاشير/);

  assert.equal((await call('POST', '/api/print-jobs/station', { token: tok.waiter, body: { name: 'x' } })).status, 403);
  const st = await call('POST', '/api/print-jobs/station', { token: tok.cashier, body: { name: 'محطة الكاشير الرئيسي' } });
  assert.equal(st.status, 200);
  const list = await call('GET', '/api/print-jobs/stations', { token: tok.waiter });
  assert.deepEqual(list.body.stations.map((x) => x.name), ['محطة الكاشير الرئيسي']);
});
