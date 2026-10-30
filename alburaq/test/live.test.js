/**
 * تطبيق الشركاء الموحّد: ما يحتاجه المطعم والسائق والإدارة لحظياً.
 *  • المطعم يرى السائق الذي قبل (اسمه ورقمه ومركبته) وكم يحتاج للوصول، ويتحدث مع حركة السائق.
 *  • لوحة الإدارة تُنبَّه بإشعار «طلب سائق من …» (brq.trip) وتصلها مدة الوصول.
 *  • سجل السائق: التوصيلات المسلّمة تدخل /driver/history.
 *  • «تذكرني» يطيل الجلسة، والمعلومات العامة، والبحث عن معلم.
 */
process.env.JWT_SECRET = 'live-secret-live-secret-live-secret-01';
process.env.JWT_REFRESH_SECRET = 'live-refresh-live-refresh-live-refr-1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { startFakeMongo } = require('./support/fakeMongo');

// إشعارات الطاقم: نلتقط ما يُرسل بدل أجهزة حقيقية
const alerts = require('../../services/staffAlertService');
const emitted = [];
alerts.emit = async (type, d) => { emitted.push({ type, d }); return null; };
// إشعارات الجوال (FCM): نلتقط ما يُرسل لكل رمز جهاز
const pushes = [];
require('../services/push').sendToTokens = async (tokens, m) => { pushes.push({ tokens, ...m }); return { sent: tokens.length, failed: 0, invalidTokens: [] }; };
const pushTo = (tok) => pushes.filter((p) => p.tokens.includes(tok));
const until = async (fn, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return fn(); };

let fm, server, base, wsBase;
const sockets = [];
const STORE = { lat: 31.9539, lng: 35.9106 };
const S = {};

async function call(token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data };
}
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/brq/ws?token=${encodeURIComponent(token)}`);
    const msgs = []; const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)); msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    ws.on('open', () => {
      sockets.push(ws);
      resolve({
        msgs,
        waitFor(pred, ms = 3000) {
          const hit = msgs.find(pred); if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res }; waiters.push(w);
            setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('لم تصل الرسالة المتوقعة')); } }, ms);
          });
        },
      });
    });
    ws.on('error', reject);
  });
}
const ttlDays = (token) => { const p = jwt.decode(token); return (p.exp - p.iat) / 86400; };

test.before(async () => {
  fm = await startFakeMongo();
  await mongoose.connect(fm.uri, { serverSelectionTimeoutMS: 5000 });
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', require('../../routes/authRoutes'));
  const realtime = require('../../services/realtimeService');
  require('..').mount(app, { realtime, sweeper: true });
  const { notFound, errorHandler } = require('../../middlewares/errorHandler');
  app.use(notFound); app.use(errorHandler);
  server = http.createServer(app);
  realtime.init(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  wsBase = base.replace('http', 'ws');
  const User = require('../../models/User');
  await User.create({ name: 'مروان', username: 'admin', password: 'admin-live-pass', role: 'admin', phone: '0790000000' });
  S.admin = (await call(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-live-pass' })).data.accessToken;
  S.area = (await call(S.admin, 'POST', '/api/brq/admin/areas', { name: 'عبدون', lat: 31.9454, lng: 35.9284 })).data.area.id;
  const c = await call(S.admin, 'POST', '/api/brq/admin/drivers', { name: 'سامر', phone: '+962790000201', pin: '1234', vehicle: 'دراجة', plate: '12-345' });
  S.driverId = c.data.driver.id;
  S.otp = (await call(S.admin, 'POST', `/api/brq/admin/drivers/${S.driverId}/otp`)).data.otp;
});

test.after(async () => {
  sockets.forEach((s) => s.terminate());
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await fm.close();
});

test('«تذكرني»: جلسة طويلة للمطعم والسائق، وقصيرة بدونه', async () => {
  const reg = await call(null, 'POST', '/api/brq/store/register', { name: 'مطعم البراق', phone: '+962790000900', password: 'secret1', ...STORE, remember: true });
  assert.equal(reg.status, 201, reg.data.message);
  S.store = reg.data.token; S.storeId = reg.data.store.id;
  assert.ok(ttlDays(S.store) >= 180, 'المطعم مع «تذكرني» ~6 أشهر');
  const short = await call(null, 'POST', '/api/brq/store/login', { phone: '+962790000900', password: 'secret1', remember: false });
  assert.ok(ttlDays(short.data.token) <= 7, 'بدون «تذكرني» أسبوع');
  // آخر دخول هو الجلسة الفعّالة: نعود لجلسة طويلة
  S.store = (await call(null, 'POST', '/api/brq/store/login', { phone: '+962790000900', password: 'secret1', remember: true })).data.token;

  const d = await call(null, 'POST', '/api/brq/driver/login', { phone: '+962790000201', pin: '1234', otp: S.otp, remember: true });
  assert.equal(d.status, 200, d.data.message);
  S.driver = d.data.token;
  assert.ok(ttlDays(S.driver) >= 60, 'السائق مع «تذكرني» شهران');
});

test('المعلومات العامة والبحث عن معلم', async () => {
  const info = await call(null, 'GET', '/api/brq/public/info');
  assert.equal(info.status, 200);
  assert.equal(info.data.meterFlagFils, 76);
  assert.ok(info.data.areas.includes('عبدون'));
  assert.equal((await call(null, 'GET', '/api/brq/geo/search?q=a')).status, 400, 'حرفان على الأقل');
});

test('المطعم يطلب ← الإدارة تُنبَّه ← السائق يقبل ← المطعم يرى السائق وكم يحتاج للوصول', async () => {
  await call(S.driver, 'POST', '/api/brq/driver/status', { status: 'available' });
  const far = { lat: STORE.lat + 0.02, lng: STORE.lng }; // ~2.2 كم عن المطعم
  await call(S.driver, 'POST', '/api/brq/driver/location', far);
  S.driverWs = await connectWs(S.driver);
  S.storeWs = await connectWs(S.store);
  S.adminWs = await connectWs(S.admin);

  // جهاز المطعم وجهاز السائق مسجّلان لإشعارات الجوال (المسار المشترك /api/brq/chat/push-token)
  assert.equal((await call(S.store, 'POST', '/api/brq/chat/push-token', { token: 'store-device-token-0123456789' })).status, 200);
  assert.equal((await call(S.driver, 'POST', '/api/brq/chat/push-token', { token: 'driver-device-token-0123456789' })).status, 200);
  assert.equal((await call(S.driver, 'POST', '/api/brq/driver/chat/push-token', { token: 'driver-device-token-0123456789' })).status, 200, 'والمسار القديم للسائق يبقى يعمل');

  const r = await call(S.store, 'POST', '/api/brq/store/trips', { stops: [{ areaId: S.area, phone: '0791234567', name: 'أبو أحمد' }] });
  assert.equal(r.status, 201, r.data.message);
  S.trip = r.data.trip.id;

  // إشعار لوحة الإدارة: «طلب سائق من مطعم البراق — انقر لتتبع الطلب»
  const note = emitted.find((e) => e.type === 'brq.trip');
  assert.ok(note, 'أُرسل إشعار brq.trip');
  assert.equal(note.d.details.store, 'مطعم البراق');
  const msg = alerts.compose('brq.trip', note.d);
  assert.match(msg.title, /طلب سائق من مطعم البراق/);
  assert.match(msg.body, /انقر لتتبع الطلب/);
  assert.equal(alerts.CATALOG.find((c) => c.type === 'brq.trip').url, 'dashboard.html#brq-map');
  await S.adminWs.waitFor((m) => m.type === 'trip.updated' && m.trip.id === S.trip);

  await S.driverWs.waitFor((m) => m.type === 'offer' && m.offer.tripId === S.trip);
  // عرض الطلب وصل جوال السائق كإشعار عاجل
  const offerPush = await until(() => pushTo('driver-device-token-0123456789').find((p) => p.data && p.data.kind === 'offer'));
  assert.ok(offerPush && offerPush.urgent, 'إشعار عرض عاجل للسائق');
  assert.equal(pushTo('store-device-token-0123456789').length, 0, 'المطعم لا يُشعَر بطلبه الذي أرسله للتو');
  assert.equal((await call(S.driver, 'POST', `/api/brq/driver/trips/${S.trip}/accept`)).status, 200);
  const acc = await until(() => pushTo('store-device-token-0123456789').find((p) => /قبل سامر/.test(p.title)));
  assert.ok(acc, 'إشعار جوال للمطعم: قبل السائق طلبك');
  assert.equal(acc.data.link, './?as=store');

  // المطعم: السائق ومدة وصوله لحظياً
  const eta = await S.storeWs.waitFor((m) => m.type === 'trip.driver' && m.tripId === S.trip);
  assert.equal(eta.driver.name, 'سامر');
  assert.equal(eta.driver.phone, '+962790000201');
  assert.equal(eta.driver.vehicle, 'دراجة');
  assert.equal(eta.target, 'store');
  assert.ok(eta.km > 2 && eta.km < 4, `مسافة الطريق التقريبية ${eta.km}`);
  assert.ok(eta.minutes >= 5 && eta.minutes <= 10, `الدقائق ${eta.minutes}`);
  assert.equal(eta.arrived, false);
  await S.adminWs.waitFor((m) => m.type === 'trip.driver' && m.tripId === S.trip);

  // وفي قائمة الطلبات أيضاً (عند فتح الصفحة من جديد)
  const list = await call(S.store, 'GET', '/api/brq/store/trips');
  const t = list.data.trips.find((x) => x.id === S.trip);
  assert.equal(t.status, 'assigned');
  assert.equal(t.live.driver.name, 'سامر');
  assert.ok(t.live.minutes > 0);

  // السائق يقترب ← تتحدث المدة عند المطعم
  const before = S.storeWs.msgs.filter((m) => m.type === 'trip.driver').length;
  await call(S.driver, 'POST', '/api/brq/driver/location', { lat: STORE.lat + 0.0003, lng: STORE.lng });
  const near = await S.storeWs.waitFor((m) => m.type === 'trip.driver' && S.storeWs.msgs.filter((x) => x.type === 'trip.driver').indexOf(m) >= before);
  assert.equal(near.arrived, true, 'السائق عند المطعم');
  await until(() => pushTo('store-device-token-0123456789').some((p) => /وصل إلى المطعم/.test(p.title)));
  assert.equal(pushTo('store-device-token-0123456789').filter((p) => /وصل إلى المطعم/.test(p.title)).length, 1, '«السائق وصل» مرة واحدة');
  await call(S.driver, 'POST', '/api/brq/driver/location', { lat: STORE.lat + 0.0002, lng: STORE.lng });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pushTo('store-device-token-0123456789').filter((p) => /وصل إلى المطعم/.test(p.title)).length, 1, 'لا تكرار');
});

test('الاستلام ← المدة للزبون، ثم التسليم يدخل سجل السائق', async () => {
  assert.equal((await call(S.store, 'POST', `/api/brq/store/trips/${S.trip}/pickup`)).status, 200);
  const list = await call(S.store, 'GET', '/api/brq/store/trips');
  assert.equal(list.data.trips.find((x) => x.id === S.trip).live.target, 'customer');

  const empty = await call(S.driver, 'GET', '/api/brq/driver/history');
  assert.equal(empty.data.trips.length, 0);
  const mine = (await call(S.driver, 'GET', '/api/brq/driver/trips')).data.trips[0];
  await call(S.driver, 'POST', '/api/brq/driver/location', mine.stops[0].areaCenter);
  const done = await call(S.driver, 'POST', `/api/brq/driver/trips/${S.trip}/stops/${mine.stops[0].id}/complete`);
  assert.equal(done.status, 200, done.data.message);
  assert.equal(done.data.trip.status, 'completed');

  const h = await call(S.driver, 'GET', '/api/brq/driver/history?limit=5');
  assert.equal(h.status, 200);
  assert.equal(h.data.trips.length, 1);
  assert.equal(h.data.trips[0].id, S.trip);
  assert.ok(h.data.trips[0].completedAt);
  assert.ok(h.data.trips[0].receiptNo);
  assert.equal(h.data.trips[0].pricing.companyFils, undefined, 'السائق لا يرى حصة الشركة في السجل');
  assert.equal((await call(S.driver, 'GET', '/api/brq/driver/trips')).data.trips.length, 0, 'اختفت من الخريطة');
  assert.equal((await call(S.store, 'GET', '/api/brq/driver/history')).status, 401);

  // تسعيرة المطعم للطباعة/PDF باسمه
  const sheet = await call(S.store, 'GET', '/api/brq/store/print/price-sheet');
  assert.equal(sheet.status, 200);
  assert.match(sheet.data.html, /id="sheet"/);
  assert.match(sheet.data.html, /خاصة ب/);
  assert.match(sheet.data.html, /مطعم البراق/);
});

test('تنبيهات الإدارة: للسائقين، للمتاجر، ولأشخاص محددين — لحظياً وعلى الجوال وفي صندوق التنبيهات', async () => {
  pushes.length = 0;
  assert.equal((await call(S.admin, 'POST', '/api/brq/admin/notices', { audience: 'drivers', title: '' })).status, 400, 'العنوان مطلوب');
  assert.equal((await call(S.driver, 'POST', '/api/brq/admin/notices', { audience: 'drivers', title: 'x' })).status, 401, 'السائق لا يرسل');

  const a = await call(S.admin, 'POST', '/api/brq/admin/notices', { audience: 'drivers', title: 'ضغط طلبات الليلة', body: 'كونوا متاحين من 8', urgent: true });
  assert.equal(a.status, 201, a.data.message);
  const got = await S.driverWs.waitFor((m) => m.type === 'notice' && m.notice.title === 'ضغط طلبات الليلة');
  assert.equal(got.notice.urgent, true);
  assert.ok(a.data.reached.online >= 1);
  assert.equal(a.data.reached.push, 1);
  const dp = await until(() => pushTo('driver-device-token-0123456789')[0]);
  assert.equal(dp.urgent, true); assert.match(dp.title, /ضغط طلبات الليلة/); assert.equal(dp.data.link, './?as=driver');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(S.storeWs.msgs.filter((m) => m.type === 'notice').length, 0, 'المتاجر لا تستلم تنبيه السائقين');

  const b = await call(S.admin, 'POST', '/api/brq/admin/notices', { audience: 'some', recipients: [{ kind: 'store', id: S.storeId }], title: 'تحديث الأسعار', body: 'من الأحد' });
  assert.equal(b.status, 201, b.data.message);
  await S.storeWs.waitFor((m) => m.type === 'notice' && m.notice.title === 'تحديث الأسعار');
  assert.equal((await until(() => pushTo('store-device-token-0123456789').filter((p) => /تحديث الأسعار/.test(p.title)).length)), 1);

  const dn = await call(S.driver, 'GET', '/api/brq/driver/notices');
  assert.deepEqual(dn.data.notices.map((n) => n.title), ['ضغط طلبات الليلة']);
  const sn = await call(S.store, 'GET', '/api/brq/store/notices');
  assert.deepEqual(sn.data.notices.map((n) => n.title), ['تحديث الأسعار']);
  const hist = await call(S.admin, 'GET', '/api/brq/admin/notices');
  assert.equal(hist.data.notices.length, 2);
  assert.equal(hist.data.notices[0].title, 'تحديث الأسعار');
});

test('إشعار الزبون بحالة طلبه: الرسائل لكل حالة', () => {
  const { messageFor } = require('../../services/customerStatusPush');
  assert.match(messageFor({ status: 'new', orderNumber: 12 }, 'pending').title, /تم تأكيد طلبك #12/);
  assert.equal(messageFor({ status: 'new', orderNumber: 12 }, 'new'), null);
  assert.equal(messageFor({ status: 'out_for_delivery', orderNumber: 12 }).urgent, true);
  assert.match(messageFor({ status: 'ready', orderNumber: 12, orderType: 'pickup' }).title, /جاهز للاستلام/);
  assert.match(messageFor({ status: 'cancelled', orderNumber: 12, cancelReason: 'نفد الصنف' }).body, /نفد الصنف/);
});
