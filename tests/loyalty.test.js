/**
 * نظام الولاء — الاختبارات العشرة المطلوبة، على المسارات الحقيقية (/api/orders و/api/loyalty)
 * وقاعدة بيانات في الذاكرة (tests/helpers/memoryDb.js) بتحقق Mongoose والفهارس الفريدة.
 *   node --test tests/loyalty.test.js
 */
process.env.JWT_SECRET = 'loyalty-test-secret-0123456789abcdef';
process.env.LOYALTY_SYNC_DELAY_MS = '10';
for (const k of Object.keys(process.env)) if (/^(APPLE_|GOOGLE_WALLET_|PUBLIC_API_URL)/.test(k)) delete process.env[k];

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const http2 = require('http2');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const jwt = require('jsonwebtoken');
const forge = require('node-forge');

// كل النماذج قبل تثبيت الذاكرة
['Order', 'Product', 'Category', 'Printer', 'Counter', 'ShiftSession', 'ActivityLog', 'Customer', 'User', 'PhoneUser', 'Setting', 'BlockedPhone',
  'LoyaltyProgram', 'LoyaltyAccount', 'LoyaltyTransaction', 'LoyaltyReward', 'AppleDeviceRegistration']
  .forEach((m) => require(`../models/${m}`));
const db = require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

const realtime = require('../services/realtimeService');
['broadcast', 'emitOrderCreated', 'emitOrderStatusChanged', 'emitOrderCancelled'].forEach((k) => { realtime[k] = () => {}; });
const loyalty = require('../services/loyaltyService');
const apple = require('../services/appleWalletService');
const google = require('../services/googleWalletService');
const walletSync = require('../services/walletSync');
walletSync.start();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(15); } return fn(); }

let server; let base;
const tokens = {};
const ids = {};

async function call(method, url, { token, body, headers = {}, raw = false } = {}) {
  const r = await fetch(base + url, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* */ }
  return { status: r.status, body: json, buf: raw ? buf : undefined, headers: r.headers };
}

let saleSeq = 0;
const sale = (items, extra = {}, token = tokens.cashier) => call('POST', '/api/orders/pos', { token, body: { items, paymentMethod: 'cash', channel: 'web', clientRef: `ref-${++saleSeq}-${Date.now()}`, ...extra } });
const balanceOf = async (phone) => (await M('LoyaltyAccount').findOne({ phone }).lean()).balance;
const txsOf = async (filter) => M('LoyaltyTransaction').find(filter).lean();

test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/orders', require('../routes/orderRoutes'));
  app.use('/api/loyalty', require('../routes/loyaltyRoutes'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const U = M('User');
  for (const [k, role] of [['admin', 'admin'], ['cashier', 'cashier'], ['employee', 'employee'], ['admin2', 'admin']]) {
    const u = await U.create({ name: k === 'admin' ? 'مروان' : k, username: k, password: 'secret123', role, isActive: true });
    ids[k] = u._id; tokens[k] = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  }
  for (const [k, phone] of [['custA', '+962791111111'], ['custB', '+962792222222']]) {
    const p = await M('PhoneUser').create({ phone, isPhoneVerified: true });
    ids[k] = p._id; tokens[k] = jwt.sign({ id: String(p._id), type: 'customer' }, process.env.JWT_SECRET);
  }
  const cat = await M('Category').create({ name: 'Burgers', nameAr: 'برجر' });
  const burger = await M('Product').create({ name: 'Burger', nameAr: 'برجر', price: 3.25, category: cat._id, addons: [{ name: 'جبنة', price: 0.5 }] });
  const fries = await M('Product').create({ name: 'Fries', nameAr: 'بطاطا', price: 1, category: cat._id });
  ids.burger = String(burger._id); ids.fries = String(fries._id);
  await M('Setting').create({ restaurantName: 'ديار الأنباط' });
  await loyalty.program(); // الافتراضي: 10 نقاط/دينار، مكافأة «خصم دينار» = 1000 نقطة
});
test.after(() => server.close());

/* ───────── 1) اكتساب النقاط بعد الدفع ───────── */
test('1) بيع الكاشير مع عضوية: النقاط تُكسب بعد الدفع، والتقريب للأسفل', async () => {
  assert.equal(loyalty.pointsFor(12.345, { earnPerJod: 10 }), 123);
  assert.equal(loyalty.pointsFor(0.099, { earnPerJod: 10 }), 0);
  assert.equal(loyalty.pointsFor(0.1, { earnPerJod: 10 }), 1);
  assert.equal(loyalty.pointsFor(3, { earnPerJod: 10 }), 30, 'لا خطأ فاصلة عائمة (29.999…)');

  const en = await call('POST', '/api/loyalty/enroll', { token: tokens.cashier, body: { phone: '0791111111', name: 'سارة' } });
  assert.equal(en.status, 201);
  assert.match(en.body.account.memberNo, /^DY-\d{6}$/);
  assert.equal(en.body.account.phone, '079****111', 'الكاشير يرى الرقم مخفياً جزئياً');

  // 3 برجر + بطاطا = 10.750 د.أ ← 107 نقاط (لا 108)
  const r = await sale([{ product: ids.burger, quantity: 3 }, { product: ids.fries, quantity: 1 }], { loyalty: { phone: '0791111111' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.total, 10.75);
  assert.equal(r.body.loyalty.pointsEarned, 107);
  assert.equal(r.body.loyalty.balance, 107);
  const order = await M('Order').findById(r.body.order._id).lean();
  assert.equal(order.loyalty.pointsEarned, 107);
  assert.equal(order.loyalty.memberNo, en.body.account.memberNo);
  const [tx] = await txsOf({ order: order._id, type: 'earn' });
  assert.equal(tx.points, 107); assert.equal(tx.amount, 10.75); assert.equal(tx.balanceAfter, 107); assert.equal(tx.idemKey, `earn:${order._id}`);

  // طلب موقع: لا نقاط قبل «تم التسليم»، ثم نقاطه عند التسليم
  const web = await M('Order').create({ orderNumber: 'W1', customerName: 'سارة', phone: '0791111111', items: [], itemsTotal: 5, deliveryFee: 1.5, total: 6.5, source: 'web', status: 'new' });
  assert.equal(await loyalty.earnForOrder({ ...web.toObject(), status: 'pending' }), null, 'معلّق = غير مدفوع');
  const st = await call('PUT', `/api/orders/${web._id}/status`, { token: tokens.cashier, body: { status: 'delivered' } });
  assert.equal(st.status, 200);
  await until(async () => (await txsOf({ order: web._id, type: 'earn' })).length);
  const [wtx] = await txsOf({ order: web._id, type: 'earn' });
  assert.equal(wtx.points, 50, 'على الأصناف فقط (5 د.أ) بلا التوصيل');
  assert.equal(await balanceOf('+962791111111'), 157);
});

/* ───────── 2) منع تكرار نقاط الفاتورة ───────── */
test('2) لا تُمنح نقاط الفاتورة مرتين: إعادة الإرسال، إعادة المحاولة، والتزامن', async () => {
  const body = { items: [{ product: ids.fries, quantity: 2 }], paymentMethod: 'cash', channel: 'web', clientRef: 'same-ref-1', loyalty: { phone: '0791111111' } };
  const a = await call('POST', '/api/orders/pos', { token: tokens.cashier, body });
  const b = await call('POST', '/api/orders/pos', { token: tokens.cashier, body });
  assert.equal(a.status, 201); assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(String(b.body.order._id), String(a.body.order._id));
  assert.equal((await txsOf({ order: a.body.order._id })).length, 1);

  const order = await M('Order').findById(a.body.order._id).lean();
  const rs = await Promise.all([loyalty.earnForOrder(order), loyalty.earnForOrder(order), loyalty.onOrderStatusChanged({ ...order, status: 'delivered' }, 'ready')]);
  assert.ok(rs.every((x) => x && x.duplicate), 'كلها مكررة');
  assert.equal((await txsOf({ order: order._id, type: 'earn' })).length, 1);

  // طلب جديد: منحان متزامنان فعلاً ← معاملة واحدة (الفهرس الفريد idemKey)
  const web = await M('Order').create({ orderNumber: 'W2', customerName: 'سارة', phone: '0791111111', items: [], itemsTotal: 2, total: 2, source: 'web', status: 'delivered' });
  const before = await balanceOf('+962791111111');
  await Promise.all([loyalty.earnForOrder(web.toObject()), loyalty.earnForOrder(web.toObject()), loyalty.earnForOrder(web.toObject())]);
  assert.equal((await txsOf({ order: web._id, type: 'earn' })).length, 1);
  assert.equal(await balanceOf('+962791111111'), before + 20);
});

/* ───────── 3) رفض استبدال رصيد غير كافٍ ───────── */
test('3) استبدال برصيد غير كافٍ يُرفض — بلا فاتورة ولا خصم ولا معاملة', async () => {
  const reward = (await loyalty.rewards(true)).find((r) => r.type === 'amount');
  const ordersBefore = db.stores.Order.size;
  const bal = await balanceOf('+962791111111');
  assert.ok(bal < reward.pointsCost);
  const r = await sale([{ product: ids.burger, quantity: 1 }], { loyalty: { phone: '0791111111', rewardId: String(reward._id) } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INSUFFICIENT');
  assert.match(r.body.message, /غير كافٍ/);
  assert.equal(db.stores.Order.size, ordersBefore, 'لم تُنشأ فاتورة');
  assert.equal(await balanceOf('+962791111111'), bal);
  assert.equal((await txsOf({ type: 'redeem' })).length, 0);

  // رصيد يكفي لمكافأة واحدة فقط وعمليتا بيع متزامنتان: تنجح واحدة
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962791111111' }).lean();
  await loyalty.adjust(acc._id, { points: reward.pointsCost - bal, reason: 'اختبار' }, { _id: ids.admin, name: 'مروان' });
  assert.equal(await balanceOf('+962791111111'), reward.pointsCost);
  const [x, y] = await Promise.all([
    sale([{ product: ids.burger, quantity: 2 }], { loyalty: { phone: '0791111111', rewardId: String(reward._id) } }),
    sale([{ product: ids.burger, quantity: 2 }], { loyalty: { phone: '0791111111', rewardId: String(reward._id) } }),
  ]);
  const ok = [x, y].filter((v) => v.status === 201); const no = [x, y].filter((v) => v.status === 409);
  assert.equal(ok.length, 1); assert.equal(no.length, 1);
  const o = ok[0].body.order;
  assert.equal(o.discount, 1, 'خصم دينار ظاهر في الفاتورة');
  assert.equal(o.total, 5.5, '6.5 − 1');
  assert.equal(o.loyalty.pointsRedeemed, reward.pointsCost);
  assert.equal(ok[0].body.loyalty.pointsEarned, 55, 'النقاط على المبلغ بعد الخصم');
  assert.equal(await balanceOf('+962791111111'), 55, 'لا رصيد سالب بالاستبدال');
  const [rt] = await txsOf({ type: 'redeem' });
  assert.equal(String(rt.order), String(o._id), 'الاستبدال مرتبط بالفاتورة');
});

/* ───────── 4) منع الوصول إلى محفظة زبون آخر ───────── */
test('4) كل زبون يرى عضويته فقط، والمسارات الإدارية مرفوضة على غير المخوّلين', async () => {
  const a = await call('GET', '/api/loyalty/me', { token: tokens.custA });
  const b = await call('GET', '/api/loyalty/me', { token: tokens.custB });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.account.phone, '0791111111');
  assert.equal(b.body.account.phone, '0792222222');
  assert.notEqual(a.body.account.memberNo, b.body.account.memberNo);
  assert.equal(b.body.account.balance, 0);
  assert.ok(!JSON.stringify(b.body).includes(a.body.account.qrCode), 'لا أثر لعضوية أخرى');
  // لا يوجد معرّف يُغيَّر في مسارات الزبون: ?id= و?phone= تُتجاهل
  const tamper = await call('GET', `/api/loyalty/me?phone=0791111111&id=${ids.custA}`, { token: tokens.custB });
  assert.equal(tamper.body.account.phone, '0792222222');
  assert.equal((await call('GET', '/api/loyalty/me')).status, 401);
  // توكن زبون على مسارات الموظفين ← 401
  assert.equal((await call('GET', '/api/loyalty/lookup?phone=0791111111', { token: tokens.custA })).status, 401);
  assert.equal((await call('GET', '/api/loyalty/admin/accounts', { token: tokens.custA })).status, 401);
  // موظف بلا loyalty:use ← 403؛ كاشير على الإدارة ← 403
  assert.equal((await call('GET', '/api/loyalty/lookup?phone=0791111111', { token: tokens.employee })).status, 403);
  assert.equal((await call('GET', '/api/loyalty/admin/accounts', { token: tokens.cashier })).status, 403);
  const accA = await M('LoyaltyAccount').findOne({ phone: '+962791111111' }).lean();
  assert.equal((await call('POST', `/api/loyalty/admin/accounts/${accA._id}/adjust`, { token: tokens.cashier, body: { points: 9999, reason: 'احتيال' } })).status, 403);
  // الرصيد لا يُرسل من الواجهة: حقول غريبة في البيع تُتجاهل
  const r = await sale([{ product: ids.fries, quantity: 1 }], { loyalty: { phone: '0792222222', balance: 1000000, pointsEarned: 99999, accountId: String(accA._id) } });
  assert.equal(r.status, 201);
  assert.equal(r.body.loyalty.memberNo, b.body.account.memberNo, 'العضوية من الرقم لا من accountId المرسل');
  assert.equal(r.body.loyalty.pointsEarned, 10);
  assert.equal(await balanceOf('+962792222222'), 10);
  // موظف بلا صلاحية لا يربط بيعاً بعضوية
  const e = await sale([{ product: ids.fries, quantity: 1 }], { loyalty: { phone: '0792222222' } }, tokens.employee);
  assert.equal(e.status, 403);
});

/* ───────── 5) تسجيل التعديلات الإدارية ───────── */
test('5) التعديل اليدوي يُسجَّل بالسبب والمستخدم، ولا يُخصم أكثر من الرصيد', async () => {
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962792222222' }).lean();
  const noReason = await call('POST', `/api/loyalty/admin/accounts/${acc._id}/adjust`, { token: tokens.admin, body: { points: 50 } });
  assert.equal(noReason.status, 400);
  const ok = await call('POST', `/api/loyalty/admin/accounts/${acc._id}/adjust`, { token: tokens.admin, body: { points: 50, reason: 'تعويض عن تأخير الطلب' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.balance, 60);
  const tx = (await txsOf({ account: acc._id, type: 'adjust' }))[0];
  assert.equal(tx.byName, 'مروان'); assert.equal(tx.reason, 'تعويض عن تأخير الطلب'); assert.equal(String(tx.byUser), String(ids.admin));
  await until(() => db.all('ActivityLog').some((l) => l.action === 'loyalty.adjust'));
  const log = db.all('ActivityLog').find((l) => l.action === 'loyalty.adjust');
  assert.equal(log.userName, 'مروان'); assert.equal(log.details.reason, 'تعويض عن تأخير الطلب'); assert.equal(log.details.points, 50);
  const over = await call('POST', `/api/loyalty/admin/accounts/${acc._id}/adjust`, { token: tokens.admin, body: { points: -1000, reason: 'تصحيح' } });
  assert.equal(over.status, 409);
  assert.equal(await balanceOf('+962792222222'), 60);
  // البرنامج والمكافآت: تعديلها مسجّل أيضاً
  const p = await call('PUT', '/api/loyalty/admin/program', { token: tokens.admin, body: { earnPerJod: 20 } });
  assert.equal(p.body.program.earnPerJod, 20);
  const rw = await call('POST', '/api/loyalty/admin/rewards', { token: tokens.admin, body: { name: 'بطاطا مجانية', type: 'free_item', product: ids.fries, pointsCost: 40 } });
  assert.equal(rw.status, 201); assert.equal(rw.body.reward.productName, 'بطاطا');
  await until(() => db.all('ActivityLog').some((l) => l.action === 'loyalty.reward.create'));
  assert.ok(db.all('ActivityLog').some((l) => l.action === 'loyalty.program' && l.details.after.earnPerJod === 20));
  await call('PUT', '/api/loyalty/admin/program', { token: tokens.admin, body: { earnPerJod: 10 } });
  // إعادة الحساب من السجل (المرجع الأساسي) — بلا فرق
  const rc = await call('POST', `/api/loyalty/admin/accounts/${acc._id}/recalc`, { token: tokens.admin });
  assert.equal(rc.body.difference, 0); assert.equal(rc.body.after, 60);
  // الصنف المجاني: يُخصم سعره الأساسي فقط، ويجب أن يكون في السلة
  const no = await sale([{ product: ids.burger, quantity: 1 }], { loyalty: { phone: '0792222222', rewardId: String(rw.body.reward._id) } });
  assert.equal(no.status, 400); assert.match(no.body.message, /أضف/);
  const yes = await sale([{ product: ids.fries, quantity: 2 }], { loyalty: { phone: '0792222222', rewardId: String(rw.body.reward._id) } });
  assert.equal(yes.status, 201); assert.equal(yes.body.order.discount, 1); assert.equal(yes.body.order.total, 1);
});

/* ───────── 6) الملغاة والمستردة ───────── */
test('6) الإلغاء بعد الدفع يعكس النقاط ويرجع المستبدلة — مرة واحدة؛ والإلغاء قبل الدفع بلا أثر', async () => {
  // طلب موقع سُلّم (كسب) ثم أُلغي (استرداد)
  const web = await M('Order').create({ orderNumber: 'W3', customerName: 'ب', phone: '0792222222', items: [], itemsTotal: 4, total: 4, source: 'web', status: 'out_for_delivery' });
  const before = await balanceOf('+962792222222');
  await call('PUT', `/api/orders/${web._id}/status`, { token: tokens.admin, body: { status: 'delivered' } });
  await until(async () => (await balanceOf('+962792222222')) === before + 40);
  const c1 = await call('PUT', `/api/orders/${web._id}/status`, { token: tokens.admin, body: { status: 'cancelled', reason: 'إرجاع' } });
  assert.equal(c1.status, 200);
  await until(async () => (await txsOf({ order: web._id, type: 'reverse_earn' })).length);
  assert.equal(await balanceOf('+962792222222'), before);
  await loyalty.onOrderStatusChanged({ ...web.toObject(), status: 'cancelled' }, 'delivered'); // تكرار
  assert.equal((await txsOf({ order: web._id, type: 'reverse_earn' })).length, 1);

  // بيع كاشير باستبدال ثم إلغاء: تعود النقاط المستبدلة وتُسحب المكتسبة
  const reward = (await loyalty.rewards(true)).find((r) => r.type === 'free_item');
  const accB = await M('LoyaltyAccount').findOne({ phone: '+962792222222' }).lean();
  await loyalty.adjust(accB._id, { points: 50, reason: 'رصيد للاختبار' }, { _id: ids.admin, name: 'مروان' });
  const bal0 = await balanceOf('+962792222222');
  assert.ok(bal0 >= reward.pointsCost);
  const s = await sale([{ product: ids.fries, quantity: 3 }], { loyalty: { phone: '0792222222', rewardId: String(reward._id) } });
  assert.equal(s.status, 201);
  const afterSale = await balanceOf('+962792222222');
  assert.equal(afterSale, bal0 - 40 + 20);
  const c2 = await call('PUT', `/api/orders/${s.body.order._id}/status`, { token: tokens.admin, body: { status: 'cancelled' } });
  assert.equal(c2.status, 200);
  await until(async () => (await txsOf({ order: s.body.order._id, type: 'reverse_redeem' })).length);
  assert.equal(await balanceOf('+962792222222'), bal0, 'كأن البيع لم يكن');

  // ملغى قبل الدفع: لا معاملات
  const pend = await M('Order').create({ orderNumber: 'W4', customerName: 'ب', phone: '0792222222', items: [], itemsTotal: 9, total: 9, source: 'web', status: 'new' });
  await call('PUT', `/api/orders/${pend._id}/status`, { token: tokens.admin, body: { status: 'cancelled' } });
  await wait(80);
  assert.equal((await txsOf({ order: pend._id })).length, 0);

  // سياسة موثّقة: سحب نقاط صُرفت يجعل الرصيد سالباً (يُسدّ من المشتريات القادمة)
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962792222222' }).lean();
  const big = await M('Order').create({ orderNumber: 'W5', customerName: 'ب', phone: '0792222222', items: [], itemsTotal: 100, total: 100, source: 'web', status: 'delivered' });
  await loyalty.earnForOrder(big.toObject());
  await loyalty.adjust(acc._id, { points: -(await balanceOf('+962792222222')), reason: 'صرف' }, { _id: ids.admin, name: 'مروان' });
  await loyalty.reverseForOrder(big.toObject());
  assert.equal(await balanceOf('+962792222222'), -1000);
  // ولا يمكن الاستبدال برصيد سالب
  const any = (await loyalty.rewards(true))[0];
  const r = await sale([{ product: ids.fries, quantity: 1 }], { loyalty: { phone: '0792222222', rewardId: String(any._id) } });
  assert.equal(r.status, any.type === 'free_item' ? 409 : 409);
  await loyalty.adjust(acc._id, { points: 1000, reason: 'تصفير الاختبار' }, { _id: ids.admin, name: 'مروان' });
});

/* ───────── أدوات الشهادات (Apple) ───────── */
function makeCert({ cn, issuer, issuerKey, ca = false, keyPair }) {
  const kp = keyPair || (() => { const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' })), publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })) }; })();
  const c = forge.pki.createCertificate();
  c.publicKey = kp.publicKey; c.serialNumber = String(Math.floor(Math.random() * 1e9));
  c.validity.notBefore = new Date(Date.now() - 86400000); c.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: cn }];
  c.setSubject(attrs); c.setIssuer(issuer ? issuer.subject.attributes : attrs);
  c.setExtensions([{ name: 'basicConstraints', cA: ca }, { name: 'keyUsage', keyCertSign: ca, digitalSignature: true, cRLSign: ca }]);
  c.sign(issuerKey || kp.privateKey, forge.md.sha256.create());
  return { cert: c, key: kp.privateKey };
}
function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22; while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const comp = buf.readUInt32LE(p + 20); const nameLen = buf.readUInt16LE(p + 28); const extra = buf.readUInt16LE(p + 30); const cmt = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42); const name = buf.slice(p + 46, p + 46 + nameLen).toString();
    const lName = buf.readUInt16LE(local + 26); const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lName + lExtra, local + 30 + lName + lExtra + comp);
    files[name] = buf.readUInt16LE(p + 10) === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extra + cmt;
  }
  return files;
}

let pki;
function configureApple() {
  const root = makeCert({ cn: 'Test Root CA', ca: true });
  const wwdr = makeCert({ cn: 'Test Apple WWDR', ca: true, issuer: root.cert, issuerKey: root.key });
  const pass = makeCert({ cn: 'Pass Type ID: pass.com.diyar.test', issuer: wwdr.cert, issuerKey: wwdr.key });
  pki = { root, wwdr, pass };
  const b64 = (s) => Buffer.from(s).toString('base64');
  Object.assign(process.env, {
    APPLE_PASS_TYPE_ID: 'pass.com.diyar.test', APPLE_TEAM_ID: 'ABCDE12345',
    APPLE_PASS_CERT_PEM_B64: b64(forge.pki.certificateToPem(pass.cert)), APPLE_PASS_KEY_PEM_B64: b64(forge.pki.privateKeyToPem(pass.key)),
    APPLE_WWDR_PEM_B64: b64(forge.pki.certificateToPem(wwdr.cert)), APPLE_PASS_AUTH_SECRET: 'x'.repeat(40), PUBLIC_API_URL: base.replace('http:', 'https:'),
  });
}

/* ───────── 7) Apple Wallet ───────── */
test('7) Apple Wallet: لا بطاقة غير موقّعة؛ ومع الشهادات ملف .pkpass موقّع يُتحقق منه بـ openssl، والتحديث يعمل', async () => {
  const off = await call('POST', '/api/loyalty/me/apple', { token: tokens.custA });
  assert.equal(off.status, 503, 'بلا شهادات: رفض واضح — لا ملفات وهمية');
  assert.ok(apple.missing().length >= 5);

  configureApple();
  assert.deepEqual(apple.missing(), []);
  const link = await call('POST', '/api/loyalty/me/apple', { token: tokens.custA });
  assert.equal(link.status, 200);
  const dlPath = new URL(link.body.url).pathname;
  const dl = await call('GET', dlPath, { raw: true });
  assert.equal(dl.status, 200, dl.buf && dl.buf.toString().slice(0, 200));
  assert.equal(dl.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const files = unzip(dl.buf);
  for (const f of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'icon@2x.png', 'logo.png']) assert.ok(files[f], `${f} موجود`);
  const manifest = JSON.parse(files['manifest.json']);
  for (const [name, sha] of Object.entries(manifest)) assert.equal(crypto.createHash('sha1').update(files[name]).digest('hex'), sha, `بصمة ${name}`);
  const pass = JSON.parse(files['pass.json']);
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962791111111' }).lean();
  assert.equal(pass.serialNumber, acc.memberNo);
  assert.equal(pass.barcodes[0].message, acc.qrCode);
  assert.equal(pass.storeCard.headerFields[0].value, acc.balance);
  assert.equal(pass.passTypeIdentifier, 'pass.com.diyar.test');
  assert.match(pass.webServiceURL, /^https:\/\/.+\/api\/loyalty\/apple$/);
  assert.ok(pass.authenticationToken.length >= 16);

  // التحقق من التوقيع بـ openssl: سلسلة الشهادة Root ← WWDR ← Pass، والمحتوى manifest.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), files['manifest.json']);
  fs.writeFileSync(path.join(dir, 'signature'), files.signature);
  fs.writeFileSync(path.join(dir, 'ca.pem'), forge.pki.certificateToPem(pki.root.cert));
  const out = execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'signature'), '-content', path.join(dir, 'manifest.json'),
    '-CAfile', path.join(dir, 'ca.pem'), '-purpose', 'any', '-out', '/dev/null'], { stdio: ['ignore', 'pipe', 'pipe'] });
  void out;
  // ملف مُعدَّل يفشل التحقق
  fs.writeFileSync(path.join(dir, 'manifest.json'), Buffer.concat([files['manifest.json'], Buffer.from(' ')]));
  assert.throws(() => execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'signature'), '-content', path.join(dir, 'manifest.json'),
    '-CAfile', path.join(dir, 'ca.pem'), '-purpose', 'any', '-out', '/dev/null'], { stdio: 'pipe' }));
  fs.rmSync(dir, { recursive: true, force: true });

  // Web Service: تسجيل الجهاز (بالرمز فقط)، والبطاقات المحدّثة، وأحدث نسخة
  const auth = { Authorization: `ApplePass ${pass.authenticationToken}` };
  const reg = `/api/loyalty/apple/v1/devices/dev1/registrations/pass.com.diyar.test/${acc.memberNo}`;
  assert.equal((await call('POST', reg, { body: { pushToken: 'tok1' }, headers: { Authorization: 'ApplePass wrong' } })).status, 401);
  assert.equal((await call('POST', reg, { body: { pushToken: 'tok1' }, headers: auth })).status, 201);
  assert.equal((await call('POST', reg, { body: { pushToken: 'tok1' }, headers: auth })).status, 200);
  const other = await M('LoyaltyAccount').findOne({ phone: '+962792222222' }).lean();
  assert.equal((await call('GET', `/api/loyalty/apple/v1/passes/pass.com.diyar.test/${other.memberNo}`, { headers: auth })).status, 401, 'رمز بطاقة لا يفتح بطاقة أخرى');
  const since = Date.now();
  await wait(5);
  await loyalty.adjust(acc._id, { points: 5, reason: 'هدية' }, { _id: ids.admin, name: 'مروان' });
  const ser = await call('GET', `/api/loyalty/apple/v1/devices/dev1/registrations/pass.com.diyar.test?passesUpdatedSince=${since}`);
  assert.equal(ser.status, 200); assert.deepEqual(ser.body.serialNumbers, [acc.memberNo]);
  const latest = await call('GET', `/api/loyalty/apple/v1/passes/pass.com.diyar.test/${acc.memberNo}`, { headers: auth, raw: true });
  assert.equal(latest.status, 200);
  assert.equal(JSON.parse(unzip(latest.buf)['pass.json']).storeCard.headerFields[0].value, acc.balance + 5, 'الرصيد الجديد في البطاقة');
  const same = await call('GET', `/api/loyalty/apple/v1/passes/pass.com.diyar.test/${acc.memberNo}`, { headers: { ...auth, 'If-Modified-Since': latest.headers.get('last-modified') } });
  assert.equal(same.status, 304);
  const me = await call('GET', '/api/loyalty/me', { token: tokens.custA });
  assert.equal(me.body.wallet.apple.status, 'added', 'جهاز مسجّل = مضافة (آلية Apple الموثوقة)');

  // إشعار APNs عند تغيّر الرصيد: خادم HTTP/2 محلي بدل Apple
  const tls = makeCert({ cn: '127.0.0.1' });
  const pushes = [];
  const apns = http2.createSecureServer({ key: forge.pki.privateKeyToPem(tls.key), cert: forge.pki.certificateToPem(tls.cert) });
  apns.on('stream', (s, h) => { let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => { pushes.push({ path: h[':path'], topic: h['apns-topic'], body: b }); s.respond({ ':status': 200 }); s.end(); }); });
  await new Promise((r) => apns.listen(0, '127.0.0.1', r));
  process.env.APPLE_APNS_HOST = `127.0.0.1:${apns.address().port}`; process.env.APPLE_APNS_INSECURE = '1';
  await loyalty.adjust(acc._id, { points: 1, reason: 'اختبار الإشعار' }, { _id: ids.admin, name: 'مروان' });
  await until(() => pushes.length);
  assert.deepEqual(pushes[0], { path: '/3/device/tok1', topic: 'pass.com.diyar.test', body: '{}' });
  apns.close();
  assert.equal((await call('DELETE', reg, { headers: auth })).status, 200);
  assert.equal(await M('AppleDeviceRegistration').countDocuments({}), 0);
});

/* ───────── 8) Google Wallet ───────── */
let gKeys; let gCalls = []; let gFail = false; let gObjects = new Map();
function configureGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  gKeys = { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
  Object.assign(process.env, {
    GOOGLE_WALLET_ISSUER_ID: '3388000000012345678',
    GOOGLE_WALLET_SA_JSON_B64: Buffer.from(JSON.stringify({ client_email: 'wallet@test.iam.gserviceaccount.com', private_key: gKeys.privatePem })).toString('base64'),
    GOOGLE_WALLET_API: 'https://wallet.google.test/v1', GOOGLE_WALLET_TOKEN_URL: 'https://oauth.google.test/token', GOOGLE_WALLET_ORIGINS: 'https://diyaralanbat.com',
  });
  google._resetForTests();
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes('.google.test')) return realFetch(url, init);
    gCalls.push({ url: u, method: init.method || 'GET', body: init.body });
    if (gFail) throw new TypeError('fetch failed (Google غير متاح)');
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/token')) {
      const assertion = new URLSearchParams(init.body).get('assertion');
      jwt.verify(assertion, gKeys.publicPem, { algorithms: ['RS256'] });
      return json(200, { access_token: 'ya29.test', expires_in: 3600 });
    }
    const m = u.match(/\/(loyaltyClass|loyaltyObject)(?:\/([^/?]+))?$/);
    const key = m && m[2] ? decodeURIComponent(m[2]) : null;
    if (m && init.method === 'POST') { const b = JSON.parse(init.body); gObjects.set(b.id, b); return json(200, b); }
    if (m && init.method === 'PATCH') { if (!gObjects.has(key)) return json(404, {}); const b = { ...gObjects.get(key), ...JSON.parse(init.body) }; gObjects.set(key, b); return json(200, b); }
    if (m) return gObjects.has(key) ? json(200, { ...gObjects.get(key), hasUsers: true }) : json(404, { error: { message: 'not found' } });
    return json(404, {});
  };
}

test('8) Google Wallet: صنف وبطاقة عبر الـ API، ورابط حفظ موقّع RS256 صالح، وتحديث الرصيد', async () => {
  const off = await call('POST', '/api/loyalty/me/google', { token: tokens.custB });
  assert.equal(off.status, 503);
  configureGoogle();
  await loyalty.updateProgram({ logoUrl: 'https://cdn.example.com/logo.png' }, { name: 'مروان' });
  const r = await call('POST', '/api/loyalty/me/google', { token: tokens.custB });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'api');
  const token = r.body.url.replace('https://pay.google.com/gp/v/save/', '');
  const claims = jwt.verify(token, gKeys.publicPem, { algorithms: ['RS256'] });
  assert.equal(claims.aud, 'google'); assert.equal(claims.typ, 'savetowallet');
  assert.equal(claims.iss, 'wallet@test.iam.gserviceaccount.com');
  assert.deepEqual(claims.origins, ['https://diyaralanbat.com']);
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962792222222' }).lean();
  const objectId = `3388000000012345678.${acc.memberNo.replace(/-/g, '_').replace(/[^\w.]/g, '_')}`;
  assert.equal(claims.payload.loyaltyObjects[0].id, google.objectIdFor(acc));
  assert.ok(objectId.length > 20);
  assert.ok(gObjects.has(google.classId()), 'الصنف أُنشئ');
  const obj = gObjects.get(google.objectIdFor(acc));
  assert.equal(obj.loyaltyPoints.balance.int, acc.balance); assert.equal(obj.barcode.value, acc.qrCode);
  assert.equal(acc.google.objectId, google.objectIdFor(acc));
  // تغيّر الرصيد ← PATCH للبطاقة
  gCalls = [];
  await loyalty.adjust(acc._id, { points: 7, reason: 'هدية' }, { _id: ids.admin, name: 'مروان' });
  await until(() => gCalls.some((c) => c.method === 'PATCH'));
  await until(async () => gObjects.get(google.objectIdFor(acc)).loyaltyPoints.balance.int === acc.balance + 7);
  const me = await call('GET', '/api/loyalty/me', { token: tokens.custB });
  assert.equal(me.body.wallet.google.status, 'added', 'hasUsers من Google');
  // الـ API غير متاح: البطاقة كاملة داخل JWT (Google ينشئها عند الحفظ)
  gFail = true;
  const fb = await call('POST', '/api/loyalty/me/google', { token: tokens.custB });
  assert.equal(fb.status, 200); assert.equal(fb.body.mode, 'jwt');
  const c2 = jwt.verify(fb.body.url.split('/save/')[1], gKeys.publicPem, { algorithms: ['RS256'] });
  assert.equal(c2.payload.loyaltyObjects[0].loyaltyPoints.balance.int, acc.balance + 7);
  assert.ok(c2.payload.loyaltyClasses, 'والصنف معها');
  gFail = false;
});

/* ───────── 9) أعطال Apple/Google لا تعطّل الكاشير ───────── */
test('9) أعطال Apple وGoogle لا تعطّل الكاشير، وتُسجَّل للإدارة', async () => {
  gFail = true;
  process.env.APPLE_APNS_HOST = '127.0.0.1:1'; // لا خادم
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962792222222' }).lean();
  await M('AppleDeviceRegistration').create({ deviceLibraryId: 'dev2', pushToken: 'tok2', passTypeId: 'pass.com.diyar.test', serialNumber: acc.memberNo, account: acc._id });
  const t0 = Date.now();
  const r = await sale([{ product: ids.burger, quantity: 1 }], { loyalty: { phone: '0792222222' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.loyalty.pointsEarned, 32);
  assert.ok(Date.now() - t0 < 2000, 'البيع لا ينتظر Apple/Google');
  const a = await until(async () => { const x = await M('LoyaltyAccount').findById(acc._id).lean(); return x.apple.lastError && x.google.lastError ? x : null; });
  assert.ok(a, 'الخطأ مسجّل على العضوية');
  const st = await call('GET', '/api/loyalty/admin/integrations', { token: tokens.admin });
  assert.equal(st.status, 200);
  assert.ok(st.body.errors.some((e) => e.wallet === 'google' && e.memberNo === acc.memberNo));
  assert.ok(st.body.errors.some((e) => e.wallet === 'apple'));
  assert.ok(!JSON.stringify(st.body).includes('PRIVATE KEY') && !JSON.stringify(st.body).includes(process.env.APPLE_PASS_AUTH_SECRET), 'لا أسرار في اللوحة');
  // شهادة تالفة: تنزيل البطاقة يرفض بوضوح، والبيع يستمر
  const good = process.env.APPLE_PASS_CERT_PEM_B64;
  process.env.APPLE_PASS_CERT_PEM_B64 = Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----').toString('base64');
  const link = await call('POST', '/api/loyalty/me/apple', { token: tokens.custB });
  const dl = await call('GET', new URL(link.body.url).pathname);
  assert.ok(dl.status >= 500);
  assert.equal((await sale([{ product: ids.fries, quantity: 1 }], { loyalty: { phone: '0792222222' } })).status, 201);
  process.env.APPLE_PASS_CERT_PEM_B64 = good;
  gFail = false; delete process.env.APPLE_APNS_HOST;
});

/* ───────── 10) لا كسر للطلبات والفواتير والطباعة ───────── */
test('10) بيع بلا ولاء وتغيير الحالات والفواتير كما كانت تماماً', async () => {
  const r = await sale([{ product: ids.burger, quantity: 2, addons: [{ name: 'جبنة' }] }], { printRequested: true });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['order', 'success'], 'نفس شكل الرد');
  const o = r.body.order;
  assert.equal(o.itemsTotal, 7.5); assert.equal(o.total, 7.5); assert.equal(o.discount, 0);
  assert.equal(o.loyalty, undefined);
  assert.equal(o.customerName, 'سفري'); assert.equal(o.source, 'pos'); assert.equal(o.status, 'preparing'); assert.equal(o.printRequested, true);
  assert.equal(o.items[0].price, 3.75, 'سعر الإضافات من القاعدة');
  assert.equal((await txsOf({ order: o._id })).length, 0);
  // الكاشير لا يلغي (كما كان)، والمدير يلغي
  assert.equal((await call('PUT', `/api/orders/${o._id}/status`, { token: tokens.cashier, body: { status: 'cancelled' } })).status, 403);
  const c = await call('PUT', `/api/orders/${o._id}/status`, { token: tokens.admin, body: { status: 'ready' } });
  assert.equal(c.status, 200); assert.equal(c.body.status, 'ready');
  // برنامج متوقف: البيع مع عضوية يعمل بلا نقاط
  await loyalty.updateProgram({ enabled: false }, { name: 'مروان' });
  const off = await sale([{ product: ids.fries, quantity: 1 }], { loyalty: { phone: '0791111111' } });
  assert.equal(off.status, 201); assert.equal(off.body.loyalty.pointsEarned, 0);
  await loyalty.updateProgram({ enabled: true }, { name: 'مروان' });
  // فشل إنشاء الفاتورة بعد الاستبدال ← تعود النقاط
  const acc = await M('LoyaltyAccount').findOne({ phone: '+962791111111' }).lean();
  await loyalty.adjust(acc._id, { points: 2000, reason: 'اختبار' }, { _id: ids.admin, name: 'مروان' });
  const before = await balanceOf('+962791111111');
  const Order = M('Order'); const realCreate = Order.create;
  Order.create = async () => { throw new Error('قاعدة البيانات لا ترد'); };
  const reward = (await loyalty.rewards(true)).find((x) => x.type === 'amount');
  const f = await sale([{ product: ids.burger, quantity: 1 }], { loyalty: { phone: '0791111111', rewardId: String(reward._id) } });
  Order.create = realCreate;
  assert.equal(f.status, 500);
  assert.equal(await balanceOf('+962791111111'), before, 'النقاط المستبدلة أُعيدت');
});
