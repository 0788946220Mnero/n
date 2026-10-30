/**
 * اختبار تكامل كامل لسير العمل — الخادم الحقيقي (Express + WebSocket + Mongoose)
 * فوق خادم MongoDB بديل داخل الذاكرة (test/support/fakeMongo.js).
 *
 * يغطي: دخول السائق (رقم + PIN + OTP)، تسجيل المتجر وكشف الأسعار، الدفعات لأقرب 5 سائقين،
 * سباق القبول، تأكيد الاستلام، التسليم قرب الزبون فقط، الجرد والتسعير، التقييم والاستبعاد،
 * انتهاء المهلة والدفعة التالية، عدة توصيلات للسائق، الإلغاء، الكول سنتر، محطة الطباعة،
 * الدردشة (نص/صوت/صلاحيات)، وحماية الأدوار.
 */
process.env.JWT_SECRET = 'e2e-secret-e2e-secret-e2e-secret-e2e';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-e2e-refresh-e2e-refresh-1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const { startFakeMongo } = require('./support/fakeMongo');
const { haversineKm } = require('../geo');

let fm, server, base, wsBase;
let realtime, dispatch;

const STORE = { lat: 31.9539, lng: 35.9106 };
const ABDOUN = { lat: 31.9454, lng: 35.9284 };
const CUSTOMER = { lat: ABDOUN.lat + 0.004, lng: ABDOUN.lng + 0.003 }; // زبون داخل منطقة عبدون
const sockets = [];

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

/** اتصال WebSocket يجمع الرسائل، مع انتظار رسالة تحقق شرطاً. */
function connectWs(token, path = '/brq/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}?token=${encodeURIComponent(token)}`);
    const msgs = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    ws.on('open', () => {
      sockets.push(ws);
      resolve({
        ws, msgs,
        waitFor(pred, ms = 3000) {
          const hit = msgs.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const w = { pred, resolve: res };
            waiters.push(w);
            setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('لم تصل الرسالة المتوقعة')); } }, ms);
          });
        },
        clear() { msgs.length = 0; },
      });
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error('ws rejected ' + res.statusCode)));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const offersFor = (client, tripId) => client.msgs.filter((m) => m.type === 'offer' && m.offer.tripId === tripId);

test.before(async () => {
  fm = await startFakeMongo();
  await mongoose.connect(fm.uri, { serverSelectionTimeoutMS: 5000 });
  // نفس خادم ديار: الدخول والمستخدمون والطباعة عن بُعد والطلبات + وحدة البراق على /api/brq
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', require('../../routes/authRoutes'));
  app.use('/api/users', require('../../routes/userRoutes'));
  app.use('/api/print-jobs', require('../../routes/printJobRoutes'));
  app.use('/api/orders', require('../../routes/orderRoutes'));
  realtime = require('../../services/realtimeService');
  require('..').mount(app, { realtime, sweeper: true });
  const { notFound, errorHandler } = require('../../middlewares/errorHandler');
  app.use(notFound);
  app.use(errorHandler);
  dispatch = require('../services/dispatchService');
  server = http.createServer(app);
  realtime.init(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  wsBase = base.replace('http', 'ws');
  // مستخدمو ديار الموجودون أصلاً في مجموعة users (نفس القاعدة)
  const User = require('../../models/User');
  await User.create({ name: 'مروان', username: 'admin', password: 'admin-e2e-pass', role: 'admin', phone: '0790000000' });
  await User.create({ name: 'أبو علي', username: 'abuali', password: 'rep-pass-1', role: 'delivery', phone: '0791112223' });
});

test.after(async () => {
  sockets.forEach((s) => s.terminate());
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await fm.close();
});

/* حالة مشتركة بين خطوات السيناريو */
const S = { drivers: [], areas: {} };

test('1. الإدارة: الدخول، المناطق، الإعدادات، والسائقون مع رمز تحقق', async () => {
  // نفس دخول ديار: اسم مستخدم + كلمة مرور + «تذكرني»
  assert.equal((await call(null, 'POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await call(null, 'POST', '/api/auth/login', { username: 'abuali', password: 'rep-pass-1' })).status, 403, 'المندوب لا يدخل اللوحة');
  const login = await call(null, 'POST', '/api/auth/login', { username: 'ADMIN', password: 'admin-e2e-pass', rememberMe: true });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.user.role, 'admin');
  assert.ok(login.data.user.permissions.includes('delivery:manage') && login.data.user.permissions.includes('images:cloud'));
  assert.ok(login.data.refreshToken);
  S.admin = login.data.accessToken;
  S.adminRefresh = login.data.refreshToken;
  assert.equal((await call(S.admin, 'GET', '/api/auth/me')).data.user.username, 'admin');

  // مندوبو ديار يظهرون لإضافتهم كسائقين
  const reps = await call(S.admin, 'GET', '/api/brq/admin/delivery-reps');
  assert.equal(reps.data.reps[0].name, 'أبو علي');
  assert.equal(reps.data.reps[0].phone, '0791112223');
  assert.equal(reps.data.reps[0].isDriver, false);

  const a1 = await call(S.admin, 'POST', '/api/brq/admin/areas', { name: 'عبدون', lat: 31.9454, lng: 35.9284 });
  const a2 = await call(S.admin, 'POST', '/api/brq/admin/areas', { name: 'الشميساني', lat: 31.975, lng: 35.905 });
  assert.equal(a1.status, 201); assert.equal(a2.status, 201);
  S.areas.abdoun = a1.data.area.id; S.areas.shmeisani = a2.data.area.id;
  assert.equal((await call(S.admin, 'POST', '/api/brq/admin/areas', { name: 'عبدون', lat: 31.9, lng: 35.9 })).status, 409);

  const st = await call(S.admin, 'GET', '/api/brq/admin/settings');
  assert.equal(st.data.settings.offerTimeoutSec, 10, 'مهلة القبول الافتراضية 10 ثوان');
  assert.equal(st.data.settings.waveSize, 5, 'أقرب 5 سائقين');
  assert.equal(st.data.settings.meterFlagFils, 76);
  assert.equal(st.data.settings.perKmFils, 18);
  const upd = await call(S.admin, 'PUT', '/api/brq/admin/settings', { companyCutPerKmFils: 4 });
  assert.equal(upd.data.settings.companyCutPerKmFils, 4);
  assert.equal((await call(S.admin, 'PUT', '/api/brq/admin/settings', { companyCutPerKmFils: 30 })).status, 400, 'نسبة الشركة لا تتجاوز سعر الكم');

  // 7 سائقين: الخمسة الأولى قرب المتجر، السادس على بعد ~8 كم، السابع خارج النطاق ~33 كم
  const offsets = [0.001, 0.002, 0.003, 0.004, 0.005, 0.07, 0.3];
  for (let i = 0; i < offsets.length; i++) {
    const phone = `+96279000010${i}`;
    const c = await call(S.admin, 'POST', '/api/brq/admin/drivers', { name: `سائق ${i + 1}`, phone, pin: '1234', vehicle: 'دراجة' });
    assert.equal(c.status, 201);
    const otp = await call(S.admin, 'POST', `/api/brq/admin/drivers/${c.data.driver.id}/otp`);
    assert.match(otp.data.otp, /^\d{12}$/);
    S.drivers.push({ id: c.data.driver.id, phone, otp: otp.data.otp, loc: { lat: STORE.lat + offsets[i], lng: STORE.lng } });
  }
});

test('2. دخول السائق: الرقم + PIN + OTP كلها مطلوبة', async () => {
  const d = S.drivers[0];
  assert.equal((await call(null, 'POST', '/api/brq/driver/login', { phone: d.phone, pin: '1234' })).status, 400);
  assert.equal((await call(null, 'POST', '/api/brq/driver/login', { phone: d.phone, pin: '1234', otp: '000000000000' })).status, 401);
  assert.equal((await call(null, 'POST', '/api/brq/driver/login', { phone: d.phone, pin: '9999', otp: d.otp })).status, 401);
  for (const drv of S.drivers) {
    const r = await call(null, 'POST', '/api/brq/driver/login', { phone: drv.phone, pin: '1234', otp: drv.otp });
    assert.equal(r.status, 200, r.data.message);
    drv.token = r.data.token;
    assert.equal(r.data.driver.pinHash, undefined);
    await call(drv.token, 'POST', '/api/brq/driver/status', { status: 'available' });
    await call(drv.token, 'POST', '/api/brq/driver/location', drv.loc);
    drv.ws = await connectWs(drv.token);
  }
  S.adminWs = await connectWs(S.admin);
  const map = await call(S.admin, 'GET', '/api/brq/admin/map');
  assert.equal(map.data.drivers.filter((x) => x.online).length, 7, 'كل السائقين ظاهرون كمتصلين على الخريطة');
});

test('3. المتجر: التسجيل بالموقع، الحسبة الفورية، وكشف الأسعار', async () => {
  const prev = await call(null, 'POST', '/api/brq/store/preview-sheet', STORE);
  assert.equal(prev.status, 200);
  assert.equal(prev.data.sheet.length, 2);
  const row = prev.data.sheet[0];
  assert.equal(row.estimateFils, 76 + Math.round(row.km * 18));

  const reg = await call(null, 'POST', '/api/brq/store/register', { name: 'مطعم الرياحين', phone: '+962790000900', password: 'secret1', ...STORE });
  assert.equal(reg.status, 201, reg.data.message);
  S.store = reg.data.token; S.storeId = reg.data.store.id;
  assert.equal((await call(null, 'POST', '/api/brq/store/register', { name: 'x', phone: '+962790000900', password: 'secret1', ...STORE })).status, 409);
  S.storeWs = await connectWs(S.store);

  const sheet = await call(S.store, 'GET', '/api/brq/store/price-sheet');
  assert.deepEqual(sheet.data.sheet.map((r) => r.areaName).sort(), ['الشميساني', 'عبدون'].sort());

  // تحريك الموقع وحفظه يعيد كشفاً محدَّثاً فوراً
  const moved = await call(S.store, 'PUT', '/api/brq/store/location', { lat: STORE.lat + 0.01, lng: STORE.lng });
  assert.notDeepEqual(moved.data.sheet.map((r) => r.km), sheet.data.sheet.map((r) => r.km));
  await call(S.store, 'PUT', '/api/brq/store/location', STORE);
});

test('4. طلب سائق: العرض يصل لأقرب 5 فقط، والقبول المتزامن يفوز به واحد', async () => {
  // رقم الزبون إلزامي منذ إرسال الطلب
  const noPhone = await call(S.store, 'POST', '/api/brq/store/trips', { areaId: S.areas.abdoun });
  assert.equal(noPhone.status, 400);
  assert.match(noPhone.data.message, /رقم هاتف الزبون مطلوب/);
  // المنطقة + رقم الزبون تكفي (الموقع اختياري)
  const r = await call(S.store, 'POST', '/api/brq/store/trips', { areaId: S.areas.abdoun, customerPhone: '0791234567' });
  assert.equal(r.status, 201, r.data.message);
  S.trip1 = r.data.trip.id;
  assert.equal(r.data.trip.customerLocation, null);
  assert.equal(r.data.trip.stops.length, 1);
  assert.equal(r.data.trip.stops[0].phone, '0791234567', 'المتجر يرى رقم زبونه');
  assert.ok(r.data.trip.estimateFils > 76, 'تقدير من مركز المنطقة');
  assert.equal(r.data.trip.status, 'searching');
  assert.equal(r.data.trip.wave, 1);

  await Promise.all(S.drivers.slice(0, 5).map((d) => d.ws.waitFor((m) => m.type === 'offer' && m.offer.tripId === S.trip1)));
  await sleep(100);
  assert.equal(offersFor(S.drivers[5].ws, S.trip1).length, 0, 'السائق السادس (أبعد) لا يصله في الدفعة الأولى');
  assert.equal(offersFor(S.drivers[6].ws, S.trip1).length, 0, 'السائق خارج النطاق لا يصله أبداً');
  const offer = offersFor(S.drivers[0].ws, S.trip1)[0].offer;
  assert.equal(offer.meterFlagFils, 76);
  assert.equal(offer.driverPerKmFils, 14, '18 − 4 حصة الشركة');
  assert.ok(new Date(offer.expiresAt) - Date.now() <= 10500, 'مهلة 10 ثوان');

  // السائق لا يرى رقم الزبون قبل القبول، والعرض لا يحمله أصلاً
  assert.equal(offer.customerPhone, undefined);

  const [a, b] = await Promise.all([
    call(S.drivers[1].token, 'POST', `/api/brq/driver/trips/${S.trip1}/accept`),
    call(S.drivers[2].token, 'POST', `/api/brq/driver/trips/${S.trip1}/accept`),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'واحد فقط يفوز');
  const winner = a.status === 200 ? S.drivers[1] : S.drivers[2];
  const loser = a.status === 200 ? S.drivers[2] : S.drivers[1];
  S.winner = winner;
  const lost = a.status === 200 ? b : a;
  assert.match(lost.data.message, /قبله غيرك|انتهى/);

  // الخاسر لا تبقى له رحلة محجوزة
  const loserTrips = await call(loser.token, 'GET', '/api/brq/driver/trips');
  assert.equal(loserTrips.data.trips.length, 0);

  // البقية تُغلق عروضهم، والمتجر يعرف السائق
  await S.drivers[0].ws.waitFor((m) => m.type === 'offer.closed' && m.tripId === S.trip1);
  const upd = await S.storeWs.waitFor((m) => m.type === 'trip.updated' && m.trip.id === S.trip1 && m.trip.status === 'assigned');
  assert.equal(upd.trip.driver.id, winner.id);

  const mine = await call(winner.token, 'GET', '/api/brq/driver/trips');
  assert.equal(mine.data.trips.length, 1);
  assert.equal(mine.data.trips[0].areaName, 'عبدون');
  assert.ok(mine.data.trips[0].areaCenter, 'السائق يرى مركز المنطقة على خريطته');
  assert.equal(mine.data.trips[0].stops[0].phone, null, 'رقم الزبون يظهر للسائق بعد الاستلام فقط');
});

test('5. الاستلام والتسليم: لا تسليم قبل الاستلام ولا بعيداً عن الزبون، ثم الجرد', async () => {
  const w = S.winner;
  assert.equal((await call(w.token, 'POST', `/api/brq/driver/trips/${S.trip1}/complete`)).status, 409, 'لا تسليم قبل تأكيد المتجر');

  const p = await call(S.store, 'POST', `/api/brq/store/trips/${S.trip1}/pickup`);
  assert.equal(p.status, 200);
  assert.equal(p.data.trip.status, 'picked');
  assert.equal(p.data.trip.pricing.driverFils, undefined, 'المتجر لا يرى أجر السائق');

  // بعد الاستلام يرى السائق رقم الزبون
  const after = await call(w.token, 'GET', '/api/brq/driver/trips');
  assert.equal(after.data.trips[0].stops[0].phone, '0791234567');

  // عند الزبون: موقع التسليم = موقع السائق (لا منع للمسافة — التسليم البعيد مسموح)
  await call(w.token, 'POST', '/api/brq/driver/location', CUSTOMER);
  const done = await call(w.token, 'POST', `/api/brq/driver/trips/${S.trip1}/complete`);
  assert.equal(done.status, 200, done.data.message);

  const km = haversineKm(STORE, CUSTOMER);
  const distanceFils = Math.round(km * 18);
  const companyFils = Math.round(km * 4);
  const driverFils = 76 + distanceFils - companyFils;
  assert.equal(done.data.trip.km, km);
  assert.equal(done.data.trip.pricing.driverFils, driverFils);
  assert.equal(done.data.trip.pricing.companyFils, undefined, 'السائق لا يرى حصة الشركة');

  const dl = await call(w.token, 'GET', '/api/brq/driver/ledger');
  assert.equal(dl.data.trips, 1);
  assert.equal(dl.data.driverFils, driverFils);

  const al = await call(S.admin, 'GET', '/api/brq/admin/ledger');
  assert.equal(al.data.totals.companyFils, companyFils);
  assert.equal(al.data.totals.storeChargeFils, 76 + distanceFils);
  assert.equal(al.data.totals.driverFils + al.data.totals.companyFils, al.data.totals.storeChargeFils);

  const admTrip = (await call(S.admin, 'GET', '/api/brq/admin/trips')).data.trips.find((t) => t.id === S.trip1);
  assert.equal(admTrip.customerPhone, '0791234567', 'الشركة تحتفظ برقم الزبون');
  assert.deepEqual(admTrip.customerLocation, CUSTOMER, 'وموقعه = موقع التسليم الفعلي');

  // السائق عاد متاحاً
  const me = await call(w.token, 'GET', '/api/brq/driver/me');
  assert.equal(me.data.driver.openTrips, 0);
  assert.equal(me.data.driver.status, 'available');
  await call(w.token, 'POST', '/api/brq/driver/location', w.loc);
});

test('5ب. طلب بأكثر من زبون: موقع من رابط مشاركة، موقع يضيفه السائق لاحقاً، وتسليم بعيد مسموح', async () => {
  const LocationLink = require('../locationLink');
  const fromLink = LocationLink.parse(`https://maps.google.com/?q=${CUSTOMER.lat},${CUSTOMER.lng}`);
  assert.ok(Math.abs(fromLink.lat - CUSTOMER.lat) < 1e-6 && Math.abs(fromLink.lng - CUSTOMER.lng) < 1e-6);
  // نقص رقم أحد الزبائن يرفض الطلب كله
  const bad = await call(S.store, 'POST', '/api/brq/store/trips', { stops: [{ phone: '0790000001', areaId: S.areas.abdoun }, { areaId: S.areas.shmeisani }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.message, /الموقع 2/);
  // نقطة بلا منطقة ولا موقع مرفوضة
  assert.equal((await call(S.store, 'POST', '/api/brq/store/trips', { stops: [{ phone: '0790000001' }] })).status, 400);

  S.drivers.forEach((d) => d.ws.clear());
  const r = await call(S.store, 'POST', '/api/brq/store/trips', { stops: [
    { phone: '0790000001', name: 'أم أحمد', lat: fromLink.lat, lng: fromLink.lng, source: 'link' },
    { phone: '0790000002', name: 'أبو خالد', areaId: S.areas.shmeisani, note: 'عمارة 5' },
  ] });
  assert.equal(r.status, 201, r.data.message);
  const t = r.data.trip;
  assert.equal(t.stops.length, 2);
  assert.equal(t.stops[0].areaName, 'عبدون', 'نقطة بموقع فقط تأخذ أقرب منطقة للعرض');
  assert.equal(t.areaName, 'عبدون +1');
  const SHM = { lat: 31.975, lng: 35.905 };
  const est = haversineKm(STORE, fromLink) + haversineKm(fromLink, SHM);
  assert.equal(t.estimateFils, 76 + Math.round(Math.round(est * 100) / 100 * 18), 'التقدير: المتجر ← الزبون 1 ← الزبون 2');

  const offer = (await S.drivers[0].ws.waitFor((m) => m.type === 'offer' && m.offer.tripId === t.id)).offer;
  assert.equal(offer.stopsCount, 2);
  const d = S.drivers[0];
  assert.equal((await call(d.token, 'POST', `/api/brq/driver/trips/${t.id}/accept`)).status, 200);
  assert.equal((await call(S.store, 'POST', `/api/brq/store/trips/${t.id}/pickup`)).status, 200);

  // الزبون الثاني أرسل موقعه للسائق (رابط واتساب) → السائق يضيفه
  const B = { lat: 31.98, lng: 35.9 };
  const stopB = t.stops[1].id;
  const setB = await call(d.token, 'POST', `/api/brq/driver/trips/${t.id}/stops/${stopB}/location`, B);
  assert.equal(setB.status, 200, setB.data.message);
  assert.deepEqual(setB.data.trip.stops[1].location, B);
  assert.equal(setB.data.trip.stops[1].locationSource, 'driver');
  // «تم التسليم» العام لا يكفي مع أكثر من زبون
  assert.equal((await call(d.token, 'POST', `/api/brq/driver/trips/${t.id}/complete`)).status, 400);

  // يسلّم الثاني أولاً عند موقعه
  await call(d.token, 'POST', '/api/brq/driver/location', B);
  const s1 = await call(d.token, 'POST', `/api/brq/driver/trips/${t.id}/stops/${stopB}/complete`);
  assert.equal(s1.status, 200, s1.data.message);
  assert.equal(s1.data.trip.status, 'picked', 'بقي زبون');
  assert.equal(s1.data.trip.stops[1].legKm, haversineKm(STORE, B));
  assert.equal((await call(d.token, 'POST', `/api/brq/driver/trips/${t.id}/stops/${stopB}/complete`)).status, 409);

  // ثم الأول — بعيداً عن موقعه المحدد (يُقبل ويُعلَّم للمراجعة)
  const FAR = { lat: 32.05, lng: 35.95 };
  await call(d.token, 'POST', '/api/brq/driver/location', FAR);
  const s2 = await call(d.token, 'POST', `/api/brq/driver/trips/${t.id}/stops/${t.stops[0].id}/complete`);
  assert.equal(s2.status, 200, s2.data.message);
  assert.equal(s2.data.trip.status, 'completed');
  const km = Math.round((haversineKm(STORE, B) + haversineKm(B, FAR)) * 100) / 100;
  assert.equal(s2.data.trip.km, km, 'مجموع الأرجل الهوائية بترتيب التسليم');
  assert.equal(s2.data.trip.pricing.driverFils, 76 + Math.round(km * 18) - Math.round(km * 4));
  const adm = (await call(S.admin, 'GET', '/api/brq/admin/trips')).data.trips.find((x) => x.id === t.id);
  assert.ok(adm.stops[0].offsetM > 300, 'التسليم البعيد عن الموقع المحدد معلَّم للمراجعة');
  assert.equal(adm.stops[1].phone, '0790000002');
  assert.equal((await call(d.token, 'GET', '/api/brq/driver/me')).data.driver.openTrips, 0);
  await call(d.token, 'POST', '/api/brq/driver/location', d.loc);
});

test('6. التقييم المتدني يستبعد السائق من طلبات هذا المتجر فقط', async () => {
  const w = S.winner;
  assert.equal((await call(S.store, 'POST', `/api/brq/store/trips/${S.trip1}/rate`, { stars: 6 })).status, 400);
  assert.equal((await call(S.store, 'POST', `/api/brq/store/trips/${S.trip1}/rate`, { stars: 2 })).status, 200);
  assert.equal((await call(S.store, 'POST', `/api/brq/store/trips/${S.trip1}/rate`, { stars: 5 })).status, 409, 'تقييم واحد فقط');
  const map = await call(S.admin, 'GET', '/api/brq/admin/map');
  assert.equal(map.data.drivers.find((d) => d.id === w.id).rating, 2, 'التقييم يظهر مع اسم السائق على الخريطة');

  S.drivers.forEach((d) => d.ws.clear());
  const r = await call(S.store, 'POST', '/api/brq/store/trips', { areaId: S.areas.shmeisani, customerPhone: '0790000003' });
  S.trip2 = r.data.trip.id;
  const others = S.drivers.filter((d) => d !== w).slice(0, 5);
  await Promise.all(others.map((d) => d.ws.waitFor((m) => m.type === 'offer' && m.offer.tripId === S.trip2)));
  await sleep(100);
  assert.equal(offersFor(w.ws, S.trip2).length, 0, 'السائق المقيَّم تقييماً متدنياً لا يصله طلب هذا المتجر');
});

test('7. انتهاء المهلة يفتح الدفعة التالية، ثم ينتهي الطلب إن لم يبق أحد', async () => {
  // الدفعة الأولى ذهبت لكل المؤهلين داخل 10 كم (5 سائقين بعد استبعاد المقيَّم).
  // نوسّع النطاق ليصبح السائق البعيد (~33 كم) مؤهلاً للدفعة الثانية.
  await call(S.admin, 'PUT', '/api/brq/admin/settings', { searchRadiusKm: 40 });
  const far = S.drivers[6];
  far.ws.clear();
  await dispatch.sweep(new Date(Date.now() + 11000));
  const t = (await call(S.admin, 'GET', '/api/brq/admin/trips')).data.trips.find((x) => x.id === S.trip2);
  assert.equal(t.wave, 2, 'فُتحت الدفعة الثانية بعد انتهاء المهلة');
  await far.ws.waitFor((m) => m.type === 'offer' && m.offer.tripId === S.trip2);
  const firstWave = S.drivers.filter((d) => d !== S.winner && d !== far);
  await firstWave[0].ws.waitFor((m) => m.type === 'offer.closed' && m.tripId === S.trip2);
  assert.equal((await call(firstWave[0].token, 'POST', `/api/brq/driver/trips/${S.trip2}/accept`)).status, 409, 'لا قبول بعد انتهاء مهلة الدفعة');

  await dispatch.sweep(new Date(Date.now() + 25000));
  const st = await S.storeWs.waitFor((m) => m.type === 'trip.updated' && m.trip.id === S.trip2 && m.trip.status === 'expired');
  assert.equal(st.trip.status, 'expired', 'لا سائق متبقٍ ← انتهى الطلب وعرف المتجر');
  await call(S.admin, 'PUT', '/api/brq/admin/settings', { searchRadiusKm: 10 });
});

test('8. عدة توصيلات مفتوحة للسائق حسب الحد، ثم يصبح مشغولاً', async () => {
  await call(S.admin, 'PUT', '/api/brq/admin/settings', { maxConcurrentTrips: 2 });
  const d0 = S.drivers[0];
  const ids = [];
  for (const name of ['زبون 1', 'زبون 2']) {
    d0.ws.clear();
    const r = await call(S.store, 'POST', '/api/brq/store/trips', { areaId: S.areas.abdoun, customerName: name, customerPhone: '0790000004' });
    assert.equal(r.status, 201, r.data.message);
    await d0.ws.waitFor((m) => m.type === 'offer' && m.offer.tripId === r.data.trip.id);
    const acc = await call(d0.token, 'POST', `/api/brq/driver/trips/${r.data.trip.id}/accept`);
    assert.equal(acc.status, 200, acc.data.message);
    ids.push(r.data.trip.id);
  }
  const me = await call(d0.token, 'GET', '/api/brq/driver/me');
  assert.equal(me.data.driver.openTrips, 2);
  assert.equal(me.data.driver.status, 'busy');
  const list = await call(d0.token, 'GET', '/api/brq/driver/trips');
  assert.deepEqual(list.data.trips.map((t) => t.customerName).sort(), ['زبون 1', 'زبون 2'], 'نقاط التسليم مع اسم الزبون والمتجر');
  assert.ok(list.data.trips.every((t) => t.storeName === 'مطعم الرياحين' && t.areaCenter), 'كل نقطة على الخريطة باسم المتجر والمنطقة');

  d0.ws.clear();
  const r3 = await call(S.store, 'POST', '/api/brq/store/trips', { areaId: S.areas.abdoun, customerPhone: '0790000005' });
  await sleep(150);
  assert.equal(offersFor(d0.ws, r3.data.trip.id).length, 0, 'المشغول بالحد الأقصى لا يصله عرض جديد');
  S.trip3 = r3.data.trip.id;

  // الإلغاء من المتجر قبل الاستلام يحرر السائق
  const c = await call(S.store, 'POST', `/api/brq/store/trips/${ids[0]}/cancel`);
  assert.equal(c.status, 200);
  const after = await call(d0.token, 'GET', '/api/brq/driver/me');
  assert.equal(after.data.driver.openTrips, 1);
  assert.equal(after.data.driver.status, 'available');
  await call(S.admin, 'POST', `/api/brq/admin/trips/${ids[1]}/cancel`);
  await call(S.admin, 'POST', `/api/brq/admin/trips/${S.trip3}/cancel`);
  await call(S.admin, 'PUT', '/api/brq/admin/settings', { maxConcurrentTrips: 1 });
});


test('9. الكول سنتر: مستخدم «شركة توصيل» يطلب باسم المتجر، والفاتورة تُطبع على جهاز الكاشير', async () => {
  // مستخدم شركة التوصيل يُنشأ من «المستخدمون» في ديار نفسه — يدخل بكلمة مروره مع «تذكرني»
  const op = await call(S.admin, 'POST', '/api/users', { name: 'ليلى', username: 'laila', password: 'company-1', role: 'company' });
  assert.equal(op.status, 201, JSON.stringify(op.data));
  const login = await call(null, 'POST', '/api/auth/login', { username: 'laila', password: 'company-1', rememberMe: true });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.ok(login.data.refreshToken, 'تذكرني');
  for (const k of ['brq:manage', 'brq:ledger', 'brq:prints', 'brq:center', 'brq:chat']) assert.ok(login.data.user.permissions.includes(k), k);
  assert.ok(!login.data.user.permissions.includes('orders:manage'), 'لا صلاحيات مطعم');
  const cc = login.data.accessToken;
  S.company = cc;
  // أقسام المطعم محجوبة عنه في الخادم نفسه
  const ord = await call(cc, 'GET', '/api/orders');
  assert.equal(ord.status, 403);
  assert.equal(ord.data.code, 'COMPANY_ONLY');
  assert.equal((await call(cc, 'GET', '/api/auth/me')).status, 200);
  assert.equal((await call(cc, 'GET', '/api/brq/callcenter/me')).data.operator.name, 'ليلى');
  // التسعير يحتاج brq:settings (لا يملكها افتراضياً) — والقراءة متاحة
  assert.equal((await call(cc, 'GET', '/api/brq/admin/settings')).status, 200);
  assert.equal((await call(cc, 'PUT', '/api/brq/admin/settings', { waveSize: 5 })).status, 403);

  // موظف سنتر المطعم (center) لا يدخل كول سنتر البراق
  await call(S.admin, 'POST', '/api/users', { name: 'سنتر', username: 'rcenter', password: 'center-1', role: 'center' });
  const rc = (await call(null, 'POST', '/api/auth/login', { username: 'rcenter', password: 'center-1' })).data.accessToken;
  assert.equal((await call(rc, 'GET', '/api/brq/callcenter/stores')).status, 403);

  const stores = await call(cc, 'GET', '/api/brq/callcenter/stores');
  assert.equal(stores.data.stores[0].name, 'مطعم الرياحين');
  const est = await call(cc, 'POST', '/api/brq/callcenter/estimate', { storeId: S.storeId, stops: [{ lat: CUSTOMER.lat, lng: CUSTOMER.lng }] });
  assert.equal(est.data.estimateFils, 76 + Math.round(haversineKm(STORE, CUSTOMER) * 18));

  // جهاز الكاشير (DiyarPOS) متصل ببث ديار /ws — يستلم مهام الطباعة عن بُعد
  const cashier = await connectWs(S.admin, '/ws');
  const order = await call(cc, 'POST', '/api/brq/callcenter/orders', {
    storeId: S.storeId, customerName: 'خالد', remote: true,
    stops: [{ phone: '0795555555', name: 'خالد', lat: CUSTOMER.lat, lng: CUSTOMER.lng }],
  });
  assert.equal(order.status, 201, order.data.message);
  assert.equal(order.data.quoteFils, est.data.estimateFils, 'التقدير من موقع الزبون المحدد');
  assert.match(order.data.invoiceHtml, /خالد/);
  assert.ok(order.data.printJob);
  const pj = await cashier.waitFor((m) => m.type === 'print.job' && m.job._id === order.data.printJob);
  assert.equal(pj.job.type, 'html');
  const claim = await call(S.admin, 'POST', `/api/print-jobs/${order.data.printJob}/claim`, { station: 'كاشير 1' });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  const html = claim.data.job.payload.html;
  assert.match(html, /شركة البراق/);
  assert.match(html, /data:image\/png;base64,/, 'الشعار مضمّن في الورقة');
  assert.match(html, /80mm/);
  assert.equal((await call(S.admin, 'PATCH', `/api/print-jobs/${order.data.printJob}`, { status: 'done' })).status, 200);
  assert.equal((await call(S.admin, 'POST', `/api/print-jobs/${order.data.printJob}/claim`, {})).status, 409, 'لا طباعة مزدوجة');

  // كشف أسعار المتجر: A4 بالشعار والختم المعتمد وأسماء المناطق (طباعة محلية بلا مهمة)
  const a4 = await call(cc, 'POST', `/api/brq/callcenter/stores/${S.storeId}/print-sheet`, { format: 'a4' });
  assert.equal(a4.status, 200);
  assert.equal(a4.data.printJob, null);
  assert.match(a4.data.html, /معتمد/);
  assert.match(a4.data.html, /<svg/);
  assert.match(a4.data.html, /عبدون/);
  assert.match(a4.data.html, /الشميساني/);
  assert.match(a4.data.html, /A4/);
  const th = await call(cc, 'POST', `/api/brq/callcenter/stores/${S.storeId}/print-sheet`, { format: 'thermal', remote: true });
  assert.ok(th.data.printJob);
  await cashier.waitFor((m) => m.type === 'print.job' && m.job._id === th.data.printJob);
  cashier.ws.close();

  await call(S.admin, 'POST', `/api/brq/admin/trips/${order.data.trip.id}/cancel`);
});

test('10. البراق — الدردشة: السائقون والإدارة، المتاجر والإدارة، الخاص، الموقع، والإشراف', async () => {
  const [a, b, c] = S.drivers;
  const ch = await call(a.token, 'GET', '/api/brq/chat/channels');
  assert.deepEqual(ch.data.groups.map((g) => g.channel), ['all'], 'السائق في مجموعة السائقين فقط');
  const direct = ch.data.contacts.find((x) => x.kind === 'driver' && x.channel.includes(b.id)).channel;
  const toAdmin = ch.data.contacts.find((x) => x.kind === 'admin').channel;
  assert.ok(ch.data.contacts.some((x) => x.kind === 'store'), 'يمكنه مراسلة المتاجر');

  b.ws.clear(); c.ws.clear(); S.storeWs.clear();
  const sent = await call(a.token, 'POST', '/api/brq/chat/messages', { channel: 'all', text: 'السلام عليكم' });
  assert.equal(sent.status, 201);
  await b.ws.waitFor((m) => m.type === 'chat.message' && m.message.text === 'السلام عليكم');
  await S.adminWs.waitFor((m) => m.type === 'chat.message' && m.message.text === 'السلام عليكم');
  await sleep(80);
  assert.ok(!S.storeWs.msgs.some((m) => m.type === 'chat.message'), 'المتاجر لا ترى مجموعة السائقين');
  assert.equal((await call(S.store, 'POST', '/api/brq/chat/messages', { channel: 'all', text: 'x' })).status, 403);

  // الإدارة تكتب في مجموعة السائقين
  const adm = await call(S.admin, 'POST', '/api/brq/chat/messages', { channel: 'all', text: 'تنبيه من الإدارة' });
  assert.equal(adm.status, 201, adm.data.message);
  assert.equal(adm.data.message.sender.kind, 'admin');
  assert.match(adm.data.message.sender.name, /الإدارة · مروان/);
  await c.ws.waitFor((m) => m.type === 'chat.message' && m.message.text === 'تنبيه من الإدارة');

  // مجموعة المتاجر والإدارة
  const sc = await call(S.store, 'GET', '/api/brq/chat/channels');
  assert.deepEqual(sc.data.groups.map((g) => g.channel), ['stores']);
  const st = await call(S.store, 'POST', '/api/brq/chat/messages', { channel: 'stores', text: 'المتاجر هنا' });
  assert.equal(st.status, 201);
  await S.adminWs.waitFor((m) => m.type === 'chat.message' && m.message.text === 'المتاجر هنا');
  assert.equal((await call(a.token, 'GET', '/api/brq/chat/messages?channel=stores')).status, 403, 'السائق لا يرى مجموعة المتاجر');

  // خاص: متجر ↔ الإدارة، والإدارة ترد
  const storeAdmin = sc.data.contacts.find((x) => x.kind === 'admin').channel;
  await call(S.store, 'POST', '/api/brq/chat/messages', { channel: storeAdmin, text: 'نحتاج سائقاً بسرعة' });
  const reply = await call(S.admin, 'POST', '/api/brq/chat/messages', { channel: storeAdmin, text: 'حاضر' });
  assert.equal(reply.status, 201);
  await S.storeWs.waitFor((m) => m.type === 'chat.message' && m.message.text === 'حاضر');

  // خاص بين سائقين: لا يراه الثالث
  await call(a.token, 'POST', '/api/brq/chat/messages', { channel: direct, text: 'رسالة خاصة' });
  await b.ws.waitFor((m) => m.type === 'chat.message' && m.message.text === 'رسالة خاصة');
  await sleep(80);
  assert.ok(!c.ws.msgs.some((m) => m.type === 'chat.message' && m.message.text === 'رسالة خاصة'), 'الثالث لا يرى الخاص');
  assert.equal((await call(c.token, 'GET', `/api/brq/chat/messages?channel=${encodeURIComponent(direct)}`)).status, 403);
  assert.equal((await call(c.token, 'POST', '/api/brq/chat/messages', { channel: 'dm:d.aaaaaaaaaaaaaaaaaaaaaaaa|d.bbbbbbbbbbbbbbbbbbbbbbbb', text: 'x' })).status, 403);

  // رسالة موقع (رابط مشاركة أو موقعي الحالي)
  const loc = await call(a.token, 'POST', '/api/brq/chat/messages', { channel: toAdmin, location: { lat: 31.95, lng: 35.91, label: 'عند المتجر' } });
  assert.equal(loc.status, 201);
  assert.deepEqual(loc.data.message.location, { lat: 31.95, lng: 35.91, label: 'عند المتجر' });

  // صوت: للطرفين والمشرف فقط
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake-opus-audio')], { type: 'audio/webm' }), 'v.webm');
  fd.append('channel', direct);
  fd.append('duration', '4');
  const v = await fetch(base + '/api/brq/chat/voice', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fd });
  const vd = await v.json();
  assert.equal(v.status, 201, vd.message);
  const mediaId = vd.message.voice.mediaId;
  const playB = await fetch(`${base}/api/brq/chat/media/${mediaId}`, { headers: { Authorization: 'Bearer ' + b.token } });
  assert.equal(Buffer.from(await playB.arrayBuffer()).toString(), 'fake-opus-audio');
  assert.equal((await fetch(`${base}/api/brq/chat/media/${mediaId}`, { headers: { Authorization: 'Bearer ' + c.token } })).status, 403);
  assert.equal((await fetch(`${base}/api/brq/chat/media/${mediaId}`, { headers: { Authorization: 'Bearer ' + S.admin } })).status, 200, 'المشرف يسمع');

  // الصورة بلا سيرفر صور مضبوط → رسالة واضحة
  const img = new FormData();
  img.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'p.jpg');
  img.append('channel', 'all');
  assert.equal((await fetch(base + '/api/brq/chat/image', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: img })).status, 503);

  // مدير النظام مشرف: يقرأ الخاص بين السائقين، ويراه في القائمة، ويحذف أي رسالة
  const mon = await call(S.admin, 'GET', `/api/brq/chat/messages?channel=${encodeURIComponent(direct)}`);
  assert.ok(mon.data.messages.length >= 2);
  const achs = await call(S.admin, 'GET', '/api/brq/chat/channels');
  assert.deepEqual(achs.data.groups.map((g) => g.channel), ['all', 'stores']);
  const sup = achs.data.recent.find((x) => x.channel === direct);
  assert.ok(sup && sup.supervised && sup.name.includes('سائق 1') && sup.name.includes('سائق 2'));
  assert.equal((await call(b.token, 'DELETE', `/api/brq/chat/messages/${sent.data.message.id}`)).status, 403, 'غير المرسل لا يحذف');
  b.ws.clear();
  assert.equal((await call(S.admin, 'DELETE', `/api/brq/chat/messages/${sent.data.message.id}`)).status, 200, 'المشرف يحذف');
  await b.ws.waitFor((m) => m.type === 'chat.message' && m.message.id === sent.data.message.id && m.message.deleted);
  // المسار القديم للسائق ما زال يعمل
  assert.equal((await call(a.token, 'GET', '/api/brq/driver/chat/channels')).status, 200);
});


test('11. الجرد والتحصيل: حصة الشركة على السائق، سند القبض، الإلغاء، والتصريح', async () => {
  const all = await call(S.admin, 'GET', '/api/brq/admin/ledger');
  assert.equal(all.status, 200);
  const row = all.data.drivers.find((d) => d.trips > 0);
  assert.ok(row, 'سائق له توصيلات مكتملة');
  assert.ok(row.companyFils > 0);
  assert.equal(row.storeChargeFils, row.driverFils + row.companyFils, 'أجرة المتجر = أجرة السائق + حصة الشركة');

  const acc = (await call(S.admin, 'GET', `/api/brq/admin/ledger/drivers/${row.driverId}`)).data.account;
  assert.equal(acc.balanceFils, acc.owedAllFils - acc.paidAllFils);
  const before = acc.balanceFils;
  assert.ok(acc.items.every((t) => /^T/.test(t.receiptNo || '')), 'لكل توصيلة رقم وصل');

  // السائق يدفع جزءاً — سند قبض برقم
  const pay = await call(S.company, 'POST', `/api/brq/admin/ledger/drivers/${row.driverId}/payments`, { amountFils: 5, note: 'حصة الشركة' });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  assert.match(pay.data.settlement.receiptNo, /^RD/);
  assert.equal(pay.data.balanceFils, before - 5);
  assert.equal((await call(S.admin, 'POST', `/api/brq/admin/ledger/drivers/${row.driverId}/payments`, { amountFils: 'x' })).status, 400);

  // طباعة السند (حراري) ووصل التوصيلة وكشف الجرد
  const rc = await call(S.company, 'POST', `/api/brq/admin/print/payment/${pay.data.settlement.id}`, {});
  assert.match(rc.data.html, new RegExp(pay.data.settlement.receiptNo));
  const tr = await call(S.company, 'POST', `/api/brq/admin/print/trip/${acc.items[0].id}`, {});
  assert.equal(tr.status, 200, JSON.stringify(tr.data));
  assert.match(tr.data.html, /حصة الشركة/);
  const stmt = await call(S.company, 'POST', `/api/brq/admin/print/driver-statement/${row.driverId}`, {});
  assert.equal(stmt.status, 200);

  // السائق يرى المتبقي عليه في تطبيقه، ووصل توصيلته
  const drv = S.drivers.find((d) => d.id === row.driverId);
  const mine = await call(drv.token, 'GET', '/api/brq/driver/ledger');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.balanceFils ?? mine.data.ledger?.balanceFils ?? mine.data.account?.balanceFils, before - 5);
  assert.equal((await call(drv.token, 'GET', `/api/brq/driver/trips/${acc.items[0].id}/receipt`)).status, 200);

  // إلغاء السند يعيد المبلغ ديناً
  assert.equal((await call(S.admin, 'POST', `/api/brq/admin/ledger/payments/${pay.data.settlement.id}/void`)).status, 200);
  assert.equal((await call(S.admin, 'GET', `/api/brq/admin/ledger/drivers/${row.driverId}`)).data.account.balanceFils, before);

  // كشف المتجر (A4 بالختم) ودفعة منه
  const stl = await call(S.admin, 'GET', '/api/brq/admin/ledger/stores');
  const srow = stl.data.stores.find((x) => x.storeId === S.storeId);
  assert.ok(srow && srow.trips > 0);
  const sacc = await call(S.admin, 'GET', `/api/brq/admin/ledger/stores/${S.storeId}`);
  assert.equal(sacc.data.account.storeChargeFils, srow.storeChargeFils);
  const sp = await call(S.admin, 'POST', `/api/brq/admin/ledger/stores/${S.storeId}/payments`, { amountFils: 100 });
  assert.match(sp.data.settlement.receiptNo, /^RS/);
  const sst = await call(S.admin, 'POST', `/api/brq/admin/print/store-statement/${S.storeId}`, {});
  assert.match(sst.data.html, /معتمد/);
  assert.match(sst.data.html, /مطعم الرياحين/);
  // المتجر يرى كشفه وكشف أسعاره من واجهته
  assert.equal((await call(S.store, 'GET', '/api/brq/store/ledger')).status, 200);
  const sps = await call(S.store, 'GET', '/api/brq/store/print/price-sheet');
  assert.match(sps.data.html, /معتمد/);

  // تصريح السائق: رقم يُولَّد مرة واحدة مع تاريخ انتهاء
  await call(S.admin, 'PATCH', `/api/brq/admin/drivers/${row.driverId}`, { plate: '12-34567', nationalId: '9871234567' });
  const p1 = await call(S.company, 'POST', `/api/brq/admin/print/permit/${row.driverId}`, {});
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.match(p1.data.html, /BRQ-\d{4}-/);
  assert.match(p1.data.html, /12-34567/);
  const d1 = (await call(S.admin, 'GET', `/api/brq/admin/drivers/${row.driverId}`)).data.driver;
  assert.ok(d1.permitNo && d1.permitExpiresAt);
  await call(S.company, 'POST', `/api/brq/admin/print/permit/${row.driverId}`, {});
  assert.equal((await call(S.admin, 'GET', `/api/brq/admin/drivers/${row.driverId}`)).data.driver.permitNo, d1.permitNo, 'نفس الرقم عند إعادة الطباعة');

  // موظف بصلاحية الطباعة وحدها لا يرى الجرد
  await call(S.admin, 'POST', '/api/users', { name: 'طباعة', username: 'printer1', password: 'printer-1', role: 'employee', permissions: ['brq:prints'] });
  const pr = (await call(null, 'POST', '/api/auth/login', { username: 'printer1', password: 'printer-1' })).data.accessToken;
  assert.equal((await call(pr, 'GET', '/api/brq/admin/ledger')).status, 403);
  assert.equal((await call(pr, 'POST', `/api/brq/admin/print/price-sheet/${S.storeId}`, { format: 'a4' })).status, 200);
  assert.equal((await call(pr, 'GET', '/api/brq/admin/map')).status, 200, 'يرى الخريطة ليختار المتجر');
  assert.equal((await call(pr, 'POST', '/api/brq/admin/areas', { name: 'x', lat: 31.9, lng: 35.9 })).status, 403);
});

test('12. المطعم ← البراق: «حالة الطلبات» تطلب سائقاً ببيانات الطلب، وحالته تعود للطلب لحظياً', async () => {
  const Order = require('../../models/Order');
  const o = await Order.create({
    orderNumber: 'C-1001', customerName: 'سلمى', phone: '0796666666', total: 7.5, orderType: 'delivery',
    source: 'center', status: 'preparing', address: 'عبدون، قرب الدوار', addressOption: 'منطقة عبدون',
    customerLatitude: CUSTOMER.lat, customerLongitude: CUSTOMER.lng, items: [],
  });
  const pos = await Order.create({ orderNumber: 'P-1', total: 3, source: 'pos', orderType: 'pickup', status: 'delivered', items: [] });
  const id = String(o._id);
  // بلا «متجر المطعم» لا يُرسل شيء
  const no = await call(S.admin, 'GET', `/api/brq/restaurant/orders/${id}/preview`);
  assert.equal(no.status, 409);
  assert.match(no.data.message, /متجر المطعم/);
  // الربط بصلاحية التسعير فقط
  assert.equal((await call(S.company, 'PUT', '/api/brq/admin/restaurant-store', { storeId: S.storeId })).status, 403);
  assert.equal((await call(S.admin, 'PUT', '/api/brq/admin/restaurant-store', { storeId: S.storeId })).status, 200);
  assert.equal((await call(S.admin, 'GET', '/api/brq/admin/settings')).data.restaurantStoreId, S.storeId);

  const pv = await call(S.admin, 'GET', `/api/brq/restaurant/orders/${id}/preview`);
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.order.phone, '0796666666');
  assert.equal(pv.data.suggestedAreaId, S.areas.abdoun, '«منطقة عبدون» = عبدون');
  assert.deepEqual(pv.data.order.location, CUSTOMER);
  assert.equal((await call(S.admin, 'GET', `/api/brq/restaurant/orders/${pos._id}/preview`)).status, 400, 'السفري ليس توصيلاً');

  // الكاشير يملك brq:request افتراضياً — ومستخدم الشركة لا يملكه لكنه يدير البراق
  await call(S.admin, 'POST', '/api/users', { name: 'كاشير', username: 'cash1', password: 'cash-pass1', role: 'cashier' });
  const cashier = (await call(null, 'POST', '/api/auth/login', { username: 'cash1', password: 'cash-pass1' })).data.accessToken;
  await call(S.admin, 'POST', '/api/users', { name: 'موظف', username: 'emp1', password: 'emp-pass1', role: 'employee' });
  const emp = (await call(null, 'POST', '/api/auth/login', { username: 'emp1', password: 'emp-pass1' })).data.accessToken;
  assert.equal((await call(emp, 'POST', `/api/brq/restaurant/orders/${id}/request`, {})).status, 403);

  const diyarWs = await connectWs(S.admin, '/ws');
  const free = S.drivers.filter((d) => d !== S.winner).slice(0, 1)[0];
  free.ws.clear();
  const req1 = await call(cashier, 'POST', `/api/brq/restaurant/orders/${id}/request`, { note: 'الطابق الثاني' });
  assert.equal(req1.status, 201, JSON.stringify(req1.data));
  const tripId = req1.data.trip.id;
  assert.equal(req1.data.trip.source.kind, 'restaurant');
  assert.equal(req1.data.trip.source.orderNumber, 'C-1001');
  assert.equal(req1.data.trip.stops[0].phone, '0796666666');
  assert.equal((await call(cashier, 'POST', `/api/brq/restaurant/orders/${id}/request`, {})).status, 409, 'لا طلب مكرر');
  let up = await diyarWs.waitFor((m) => m.type === 'order.updated' && m.order._id === id && m.order.brq && m.order.brq.status === 'searching');
  assert.equal(up.order.brq.label, 'بحث عن سائق');

  // السائق يقبل ← الطلب في المطعم يعرف اسمه
  await free.ws.waitFor((m) => m.type === 'offer' && m.offer.tripId === tripId);
  const acc = await call(free.token, 'POST', `/api/brq/driver/trips/${tripId}/accept`);
  assert.equal(acc.status, 200, acc.data.message);
  up = await diyarWs.waitFor((m) => m.type === 'order.updated' && m.order._id === id && m.order.brq.status === 'assigned');
  assert.ok(up.order.brq.driverName);
  const saved = await Order.findById(id).lean();
  assert.equal(saved.brq.status, 'assigned');

  // الإلغاء من «حالة الطلبات» قبل الاستلام
  const c = await call(cashier, 'POST', `/api/brq/restaurant/orders/${id}/cancel`);
  assert.equal(c.status, 200);
  await diyarWs.waitFor((m) => m.type === 'order.updated' && m.order._id === id && m.order.brq.status === 'cancelled');
  diyarWs.ws.close();
});

test('13. الصلاحيات: إخفاء المطعم والتوصيل عن بعضهما، والجلسة الواحدة', async () => {
  // المدير (manager) يعمل في المطعم ولا يرى شركة البراق (عدا طلب سائق للطلب)
  await call(S.admin, 'POST', '/api/users', { name: 'سامي', username: 'sami', password: 'manager-1', role: 'manager' });
  const m = (await call(null, 'POST', '/api/auth/login', { username: 'sami', password: 'manager-1' })).data;
  assert.ok(m.user.permissions.includes('brq:request'));
  assert.ok(!m.user.permissions.includes('brq:manage'));
  assert.equal((await call(m.accessToken, 'GET', '/api/brq/admin/map')).status, 403);
  assert.equal((await call(m.accessToken, 'GET', '/api/brq/chat/channels')).status, 403);
  assert.equal((await call(m.accessToken, 'GET', '/api/orders')).status, 200, 'المطعم كما هو');

  // مدير النظام يمنح موظفاً أقسام البراق التي يريدها فقط
  await call(S.admin, 'POST', '/api/users', { name: 'هبة', username: 'hiba', password: 'hiba-pass', role: 'employee', permissions: ['brq:manage', 'brq:chat'] });
  const h = (await call(null, 'POST', '/api/auth/login', { username: 'hiba', password: 'hiba-pass' })).data.accessToken;
  assert.equal((await call(h, 'GET', '/api/brq/admin/map')).status, 200);
  assert.equal((await call(h, 'PUT', '/api/brq/admin/settings', { waveSize: 5 })).status, 403, 'التسعير يحتاج brq:settings');
  assert.equal((await call(h, 'GET', '/api/brq/admin/ledger')).status, 403, 'الجرد يحتاج brq:ledger');
  assert.equal((await call(h, 'GET', '/api/brq/callcenter/stores')).status, 403, 'الكول سنتر يحتاج brq:center');
  // يراسل كـ«الإدارة» لكنه ليس مشرفاً: لا يقرأ الخاص بين السائقين
  const ch = await call(h, 'GET', '/api/brq/chat/channels');
  assert.equal(ch.status, 200);
  assert.equal((await call(h, 'GET', `/api/brq/chat/messages?channel=${encodeURIComponent(`dm:d.${S.drivers[0].id}|d.${S.drivers[1].id}`)}`)).status, 403);

  // مراقب البيانات لا يرى التوصيل حتى لو مُنح صلاحيته بالخطأ
  await call(S.admin, 'POST', '/api/users', { name: 'مراقب', username: 'obs', password: 'obs-pass', role: 'observer', permissions: ['brq:manage'] });
  const o = (await call(null, 'POST', '/api/auth/login', { username: 'obs', password: 'obs-pass' })).data.accessToken;
  assert.equal((await call(o, 'GET', '/api/brq/admin/map')).status, 403);

  // الحساب المعطّل يسقط فوراً
  const users = (await call(S.admin, 'GET', '/api/users')).data;
  const hiba = (users.data || users.users || []).find((u) => u.username === 'hiba');
  assert.equal((await call(S.admin, 'PUT', `/api/users/${hiba._id}`, { isActive: false })).status, 200);
  assert.equal((await call(h, 'GET', '/api/brq/admin/map')).status, 401);

  // التجديد بـ «تذكرني»
  const r = await call(null, 'POST', '/api/auth/refresh', { refreshToken: S.adminRefresh });
  assert.equal(r.status, 200);
  assert.equal((await call(r.data.accessToken, 'GET', '/api/brq/admin/map')).status, 200);

  // جلسة واحدة: دخول الحساب نفسه من جهاز آخر يُخرج الأول (HTTP وبث البراق)
  const oldWs = await connectWs(S.admin);
  const again = await call(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin-e2e-pass', rememberMe: true });
  await oldWs.waitFor((x) => x.type === 'session.replaced');
  const old = await call(S.admin, 'GET', '/api/brq/admin/map');
  assert.equal(old.status, 401);
  assert.equal(old.data.code, 'SESSION_REPLACED');
  S.admin = again.data.accessToken;
  assert.equal((await call(S.admin, 'GET', '/api/brq/admin/map')).status, 200);
});

test('14. حماية الأدوار والجلسات والأخطاء', async () => {
  const d = S.drivers[3];
  assert.equal((await call(d.token, 'GET', '/api/brq/admin/drivers')).status, 401, 'السائق لا يدخل لوحة الإدارة');
  assert.equal((await call(d.token, 'GET', '/api/orders')).status, 401, 'ولا خادم المطعم');
  assert.equal((await call(S.store, 'GET', '/api/brq/driver/me')).status, 401, 'المتجر ليس سائقاً');
  assert.equal((await call(S.store, 'GET', '/api/brq/callcenter/stores')).status, 401);
  assert.equal((await call(d.token, 'POST', '/api/brq/driver/trips/not-an-id/accept')).status, 400, 'معرّف غير صالح ← 400 لا 500');
  assert.equal((await call(S.admin, 'GET', '/api/brq/restaurant/orders/not-an-id/preview')).status, 400);
  assert.equal((await call(S.store, 'POST', '/api/brq/store/trips', { areaId: S.areas.abdoun, customerPhone: '12', customerLat: 1, customerLng: 1 })).status, 400);
  assert.equal((await call(null, 'GET', '/api/brq/nothing')).status, 404);

  // تغيير الـ PIN يُبطل الجلسة فوراً
  await call(S.admin, 'POST', `/api/brq/admin/drivers/${d.id}/pin`, { pin: '5678' });
  assert.equal((await call(d.token, 'GET', '/api/brq/driver/me')).status, 401);
  // تعطيل المتجر يُبطل جلسته
  await call(S.admin, 'POST', `/api/brq/admin/stores/${S.storeId}/active`, { active: false });
  assert.equal((await call(S.store, 'GET', '/api/brq/store/me')).status, 401);

  const health = await call(null, 'GET', '/api/brq/health');
  assert.equal(health.status, 200);
});
