const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, isWithinMeters } = require('../geo');
const { deliveryPricing } = require('../pricing');
const { publicTrip } = require('../publicTrip');
const { pickCandidates, lowRatedDriverIds } = require('../dispatch');

const AMMAN = { lat: 31.9539, lng: 35.9106 };
const ZARQA = { lat: 32.0728, lng: 36.0880 };

test('المسافة الهوائية بين عمّان والزرقاء قريبة من 20 كم', () => {
  const km = haversineKm(AMMAN, ZARQA);
  assert.ok(km > 19 && km < 23, `المسافة: ${km}`);
  assert.equal(haversineKm(AMMAN, AMMAN), 0);
});

test('التسعير: فتحة العداد 76 تذهب للسائق كاملة، والكيلومتر يُقسَّم بين السائق والشركة', () => {
  const p = deliveryPricing({ km: 5, meterFlagFils: 76, perKmFils: 18, companyCutPerKmFils: 4 });
  assert.equal(p.storeChargeFils, 76 + 90);           // المتجر يدفع الفتح + 5 × 18
  assert.equal(p.companyFils, 20);                     // الشركة: 5 × 4 من الـ18
  assert.equal(p.driverFils, 76 + 5 * 14);            // السائق: الفتح + 5 × (18 − 4)
  assert.equal(p.driverFils + p.companyFils, p.storeChargeFils);
});

test('التسعير: الكيلومترات الهوائية تُحسب بالتقريب، ونسبة الشركة لا تتجاوز سعر الكم', () => {
  const p = deliveryPricing({ km: 2.345, meterFlagFils: 76, perKmFils: 18, companyCutPerKmFils: 50 });
  assert.equal(p.km, 2.35);
  assert.equal(p.companyCutPerKmFils, 18);            // مقيّدة بسعر الكم
  assert.equal(p.driverFils, 76);
  assert.equal(Number.isInteger(p.storeChargeFils), true);
});

test('التسعير: بلا نسبة للشركة يأخذ السائق كل الـ18 قرش لكل كم', () => {
  const p = deliveryPricing({ km: 1, meterFlagFils: 76, perKmFils: 18, companyCutPerKmFils: 0 });
  assert.equal(p.driverFils, 94);
  assert.equal(p.companyFils, 0);
});

test('التحقق من القرب من الزبون بالمتر', () => {
  const customer = { lat: 31.9541, lng: 35.9108 };
  assert.equal(isWithinMeters({ lat: 31.9542, lng: 35.9108 }, customer, 300), true);   // ~11 م
  assert.equal(isWithinMeters({ lat: 31.9600, lng: 35.9108 }, customer, 300), false);  // ~700 م
  assert.equal(isWithinMeters(null, customer, 300), false);
});

test('بيانات الزبون: السائق لا يرى رقم الزبون قبل تأكيد الاستلام، والإدارة ترى كل شيء', () => {
  const trip = {
    _id: 'x1', store: 's1', storeName: 'الرياحين', areaName: 'عبدون', status: 'assigned',
    customer: { phone: '+962790000000', lat: 31.95, lng: 35.91 }, wave: 1,
  };
  const beforePickup = publicTrip(trip, 'driver');
  assert.equal(beforePickup.customerPhone, null);
  assert.deepEqual(beforePickup.customerLocation, { lat: 31.95, lng: 35.91 });
  const afterPickup = publicTrip({ ...trip, status: 'picked' }, 'driver');
  assert.equal(afterPickup.customerPhone, '+962790000000');
  assert.equal(publicTrip(trip, 'admin').customerPhone, '+962790000000');
});

const drv = (id, lat, lng, extra = {}) => ({
  id, active: true, online: true, status: 'available', hasCurrentTrip: false,
  lastLocation: { lat, lng }, ...extra,
});

test('الاختيار يرتّب الأقرب أولاً ويقطع عند العدد المطلوب', () => {
  const store = AMMAN;
  const drivers = [
    drv('far', 31.99, 35.99),
    drv('near', 31.9541, 35.9108),
    drv('mid', 31.97, 35.93),
  ];
  const picked = pickCandidates({ drivers, store, radiusKm: 50, count: 2 });
  assert.deepEqual(picked.map((p) => p.id), ['near', 'mid']);
});

test('يستبعد: المشغول، غير المتصل، المعطّل، والذي عُرض عليه سابقاً', () => {
  const store = AMMAN;
  const drivers = [
    drv('busy', 31.9541, 35.9108, { status: 'busy' }),
    drv('hasTrip', 31.9541, 35.9108, { hasCurrentTrip: true }),
    drv('offline', 31.9541, 35.9108, { online: false }),
    drv('disabled', 31.9541, 35.9108, { active: false }),
    drv('already', 31.9541, 35.9108),
    drv('ok', 31.955, 35.911),
  ];
  const picked = pickCandidates({ drivers, store, excludeIds: new Set(['already']), radiusKm: 10, count: 5 });
  assert.deepEqual(picked.map((p) => p.id), ['ok']);
});

test('يستبعد السائق الذي قيّمه هذا المتجر تقييماً متدنياً', () => {
  const ratings = [{ driver: 'bad', avg: 2 }, { driver: 'good', avg: 4.5 }];
  const low = lowRatedDriverIds(ratings, 3);
  const picked = pickCandidates({
    drivers: [drv('bad', 31.9541, 35.9108), drv('good', 31.96, 35.92)],
    store: AMMAN, lowRatedIds: low, radiusKm: 10, count: 5,
  });
  assert.deepEqual(picked.map((p) => p.id), ['good']);
});

test('يستبعد السائق خارج نطاق البحث', () => {
  const picked = pickCandidates({
    drivers: [drv('far', 32.0728, 36.0880)], store: AMMAN, radiusKm: 10, count: 5,
  });
  assert.equal(picked.length, 0);
});

const { buildPriceSheet } = require('../services/priceSheet');
test('ورقة الأسعار: تقدير = فتحة العداد + كم المنطقة × سعر الكم، مرتبة من الأقرب', () => {
  const settings = { meterFlagFils: 76, perKmFils: 18 };
  const areas = [
    { _id: 'z', name: 'الزرقاء', center: ZARQA, active: true },
    { _id: 'a', name: 'عبدون', center: { lat: 31.9454, lng: 35.9284 }, active: true },
    { _id: 'x', name: 'معطلة', center: AMMAN, active: false },
  ];
  const sheet = buildPriceSheet(AMMAN, areas, settings);
  assert.deepEqual(sheet.map((r) => r.areaName), ['عبدون', 'الزرقاء']);
  assert.equal(sheet[0].estimateFils, 76 + Math.round(sheet[0].km * 18));
  assert.ok(sheet[1].estimateFils > sheet[0].estimateFils);
});

const { dmChannel, dmParts, canRead, canWrite } = require('../chat/channel');
test('قنوات الدردشة: المجموعتان، الخاص للطرفين، والمشرف يقرأ ولا يكتب في خاص غيره', () => {
  const D1 = 'd.' + 'a'.repeat(24), D2 = 'd.' + 'b'.repeat(24), S1 = 's.' + 'c'.repeat(24);
  const drv = { key: D1, kind: 'driver' }, drv2 = { key: D2, kind: 'driver' }, sto = { key: S1, kind: 'store' };
  const adm = { key: 'admin', kind: 'admin', admin: true }, sup = { key: 'admin', kind: 'admin', admin: true, monitor: true };
  assert.equal(canWrite(drv, 'all'), true);
  assert.equal(canRead(sto, 'all'), false);
  assert.equal(canWrite(sto, 'stores'), true);
  assert.equal(canRead(drv, 'stores'), false);
  assert.equal(canWrite(adm, 'all') && canWrite(adm, 'stores'), true);
  const ch = dmChannel(D2, D1);
  assert.equal(ch, dmChannel(D1, D2));
  assert.deepEqual(dmParts(ch), [D1, D2]);
  assert.equal(canRead(drv, ch), true);
  assert.equal(canRead(sto, ch), false);
  assert.equal(canRead(adm, ch), false, 'الإدارة بلا إشراف لا تقرأ خاص السائقين');
  assert.equal(canRead(sup, ch), true, 'المشرف يقرأ');
  assert.equal(canWrite(sup, ch), false, 'ولا يكتب فيه');
  const sa = dmChannel(S1, 'admin');
  assert.equal(canWrite(adm, sa) && canWrite(sto, sa), true);
  assert.equal(canRead(drv2, sa), false);
  assert.equal(dmParts('dm:d.x|d.y'), null);
  assert.equal(dmParts(`dm:${D1}|${D1}`), null);
  assert.equal(canRead(drv, 'bogus'), false);
});

const LocationLink = require('../locationLink');
test('رابط مشاركة الموقع: جوجل، واتساب، آبل، ويز، geo، إحداثيات ودرجات', () => {
  const P = { lat: 31.953949, lng: 35.910635 };
  const cases = [
    'https://maps.google.com/?q=31.953949,35.910635',
    'https://www.google.com/maps?q=31.953949,35.910635&z=17',
    'https://www.google.com/maps/search/?api=1&query=31.953949%2C35.910635',
    'https://www.google.com/maps/place/%D9%85%D8%B7%D8%B9%D9%85/@31.95,35.91,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d31.953949!4d35.910635',
    'https://www.google.com/maps/@31.953949,35.910635,15z',
    'https://maps.google.com/maps?daddr=31.953949,35.910635',
    'موقعي: https://maps.google.com/maps?q=31.953949%2C35.910635&z=17&hl=ar',
    'https://maps.apple.com/?ll=31.953949,35.910635&q=Pin',
    'https://waze.com/ul?ll=31.953949%2C35.910635&navigate=yes',
    'geo:31.953949,35.910635?z=16',
    '31.953949, 35.910635',
    '31.953949،35.910635',
    'https://www.google.com/maps/search/31.953949,+35.910635',
  ];
  for (const c of cases) assert.deepEqual(LocationLink.parse(c), P, c);
  const dms = LocationLink.parse(`31°57'14.2"N 35°54'38.3"E`);
  assert.ok(Math.abs(dms.lat - 31.95394) < 1e-4 && Math.abs(dms.lng - 35.91064) < 1e-4);
  assert.equal(LocationLink.parse('https://example.com/nothing'), null);
  assert.equal(LocationLink.parse('مرحبا'), null);
  assert.equal(LocationLink.parse('0,0'), null);
  assert.equal(LocationLink.isShortLink('https://maps.app.goo.gl/AbCdEf123'), true);
  assert.equal(LocationLink.isShortLink('https://goo.gl/maps/xyz'), true);
  assert.equal(LocationLink.isShortLink('https://maps.google.com/?q=1,2'), false);
});

const { resolve, allowed } = require('../services/locationResolver');
test('الروابط المختصرة: الخادم يتتبّع التحويلات لنطاقات الخرائط فقط', async () => {
  const hops = [];
  const fakeFetch = async (url) => {
    hops.push(url);
    if (url.startsWith('https://maps.app.goo.gl/')) return { status: 302, headers: new Map([['location', 'https://www.google.com/maps/place/x/@31.9,35.9,17z/data=!3d31.953949!4d35.910635']]), text: async () => '' };
    throw new Error('unexpected ' + url);
  };
  fakeFetch.headersFix = true;
  const wrap = async (u, o) => { const r = await fakeFetch(u, o); return { ...r, headers: { get: (k) => r.headers.get(k) } }; };
  assert.deepEqual(await resolve('https://maps.app.goo.gl/AbC123', { fetchImpl: wrap }), { lat: 31.953949, lng: 35.910635, resolvedUrl: 'https://www.google.com/maps/place/x/@31.9,35.9,17z/data=!3d31.953949!4d35.910635' });
  assert.equal(hops.length, 1);
  // تحويل إلى نطاق غريب يُرفض (حماية من SSRF)
  const evil = async () => ({ status: 302, headers: { get: () => 'http://169.254.169.254/latest' }, text: async () => '' });
  await assert.rejects(resolve('https://maps.app.goo.gl/evil', { fetchImpl: evil }), /ليس من خرائط/);
  await assert.rejects(resolve('https://evil.example.com/x', { fetchImpl: evil }), /ليس من خرائط/);
  assert.equal(allowed('www.google.jo'), true);
  assert.equal(allowed('google.com.evil.io'), false);
  assert.equal(allowed('localhost'), false);
});

const { invoiceHtml, priceSheetHtml } = require('../receipts');
test('الفاتورة: تحمل اسم الشركة والمتجر والمنطقة، وتهرّب النص الخطير من اسم الزبون', () => {
  const html = invoiceHtml({
    brand: 'شركة البراق', logoUrl: 'https://x.test/shared/logo.png', invoiceNo: 'INV-1',
    storeName: 'مطعم الرياحين', areaName: 'عبدون', customerName: '<script>alert(1)</script>',
    customerPhone: '+962790000000', customerLocation: { lat: 31.95, lng: 35.91 },
    estimateFils: 166, meterFlagFils: 76, perKmFils: 18, operatorName: 'أحمد',
  });
  assert.match(html, /شركة البراق/);
  assert.match(html, /مطعم الرياحين/);
  assert.match(html, /عبدون/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /166 قرش/);
});

test('كشف الأسعار: صف لكل منطقة بالمسافة والسعر', () => {
  const html = priceSheetHtml({
    brand: 'شركة البراق', logoUrl: '', storeName: 'الرياحين', storeLocation: { lat: 31.95, lng: 35.91 },
    sheet: [{ areaName: 'عبدون', km: 2.5, estimateFils: 121 }, { areaName: 'الزرقاء', km: 20, estimateFils: 436 }],
    settings: { meterFlagFils: 76, perKmFils: 18 },
  });
  assert.match(html, /عبدون/);
  assert.match(html, /الزرقاء/);
  assert.match(html, /121 قرش/);
  assert.match(html, /80mm/);
});
