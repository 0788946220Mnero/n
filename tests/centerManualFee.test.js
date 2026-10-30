/**
 * بيع السنتر بلا خريطة إلزامية: أجرة توصيل يدوية من الموظف.
 *   • يُنشأ طلب التوصيل بلا GPS ولا إحداثيات، بالمنطقة والعنوان النصي والأجرة اليدوية
 *   • الأجرة اليدوية لا تُستبدل بتعرفة محسوبة حتى مع وجود موقع
 *   • الصفر يُقبل فقط حين تعرف قواعد التوصيل المجاني · قيم غير رقمية تُرفض
 *   • الإجمالي = الأصناف + الأجرة · السلوك القديم (بلا أجرة يدوية) كما هو
 */
process.env.JWT_SECRET = 'center-manual-fee-secret-0123456789abcdef';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'Order', 'Product', 'Customer', 'Setting', 'BlockedPhone', 'PresenceSession', 'Counter', 'Printer', 'ActivityLog', 'Category']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const realtime = require('../services/realtimeService');
const pushService = require('../services/pushService');
realtime.emitOrderCreated = () => {};
pushService.notifyNewOrder = async () => {};

let server; let base; let token; let product;
const call = async (body) => {
  const r = await fetch(`${base}/api/center/orders`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const order = (extra) => ({
  customerName: 'أبو أحمد', phone: '0791234567', orderType: 'delivery', addressOption: 'الهاشمي', addressDetail: 'قرب مسجد النور، عمارة 5',
  items: [{ product: String(product._id), nameAr: 'منسف', quantity: 2 }], paymentMethod: 'cash', clientRef: `c-${Math.random()}`, ...extra,
});
const setDelivery = async (d) => {
  await M('Setting').deleteMany({});
  await M('Setting').create({ delivery: { enabled: true, restaurantLatitude: 31.95, restaurantLongitude: 35.91, ...d } });
};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/center', require('../routes/centerRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const u = await M('User').create({ name: 'سنتر', username: 'center1', password: 'secret123', role: 'admin', isActive: true });
  token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  const cat = await M('Category').create({ nameAr: 'رئيسية' });
  product = await M('Product').create({ name: 'mansaf', nameAr: 'منسف', price: 9, isAvailable: true, category: cat._id });
});
test.after(() => server.close());

test('توصيل بلا خريطة ولا GPS: أجرة يدوية والإجمالي = الأصناف + الأجرة', async () => {
  // قواعد مسافة (تحتاج موقعاً عادةً) — اليدوية تتجاوزها
  await setDelivery({ pricingMode: 'perKm', freeDistanceKm: 1, pricePerKm: 0.5 });
  const legacy = await call(order({}));
  assert.equal(legacy.status, 400, 'السلوك القديم كما هو: بلا أجرة يدوية يطلب الموقع');
  assert.equal(legacy.body.code, 'LOCATION_REQUIRED');

  const r = await call(order({ manualDeliveryFee: 1.25 }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = r.body.order;
  assert.equal(o.deliveryFee, 1.25);
  assert.equal(o.deliveryFeeManual, true);
  assert.equal(o.itemsTotal, 18);
  assert.equal(o.total, 19.25);
  assert.equal(o.customerLatitude, null, 'لا إحداثيات وهمية');
  assert.equal(o.customerLongitude, null);
  assert.equal(o.address, 'الهاشمي — قرب مسجد النور، عمارة 5');
  assert.equal(o.source, 'center');
});

test('الأجرة اليدوية لا تُستبدل بتعرفة محسوبة حتى مع وجود موقع', async () => {
  // موقع على بُعد ~5 كم: التعرفة المحسوبة 2.000 — اليدوية 0.750 تبقى
  const r = await call(order({ manualDeliveryFee: 0.75, latitude: 31.995, longitude: 35.91 }));
  assert.equal(r.status, 201);
  assert.equal(r.body.order.deliveryFee, 0.75);
  assert.equal(r.body.order.customerLatitude, 31.995, 'الموقع الحقيقي يُحفظ إن أُرسل');
  assert.equal(r.body.order.total, 18.75);
});

test('الصفر: مقبول حين تعرف القواعد المجاني فقط · والقيم غير الصالحة مرفوضة', async () => {
  await setDelivery({ pricingMode: 'perKm', freeDistanceKm: 1 });
  assert.equal((await call(order({ manualDeliveryFee: 0 }))).status, 201, 'مسافة مجانية = المجاني معروف');
  await setDelivery({ pricingMode: 'perKm', freeDistanceKm: 0 });
  const zero = await call(order({ manualDeliveryFee: 0 }));
  assert.equal(zero.status, 400); assert.equal(zero.body.code, 'FREE_NOT_ALLOWED');
  await setDelivery({ pricingMode: 'tiered', tier1Fee: 0 });
  assert.equal((await call(order({ manualDeliveryFee: 0 }))).status, 201, 'شريحة أولى مجانية');
  for (const bad of [-1, 'abc', 101]) {
    const r = await call(order({ manualDeliveryFee: bad }));
    assert.equal(r.status, 400, `قيمة ${bad}`); assert.equal(r.body.code, 'INVALID_FEE');
  }
});

test('الاستلام لا أجرة فيه، والتوصيل بلا عنوان مرفوض، وإعادة الإرسال لا تكرر الطلب', async () => {
  const p = await call(order({ orderType: 'pickup', manualDeliveryFee: 3 }));
  assert.equal(p.status, 201); assert.equal(p.body.order.deliveryFee, 0); assert.equal(p.body.order.total, 18);
  assert.equal((await call(order({ addressOption: '', addressDetail: '', manualDeliveryFee: 1 }))).status, 400);
  const body = order({ manualDeliveryFee: 1, clientRef: 'same-ref' });
  const a = await call(body); const b = await call(body);
  assert.equal(a.body.order.orderNumber, b.body.order.orderNumber); assert.equal(b.body.duplicate, true);
});

test('إعدادات التوصيل العامة تخبر الواجهة هل المجاني مسموح', () => {
  const { freeAllowed } = require('../controllers/centerController');
  assert.equal(freeAllowed({ pricingMode: 'perKm', freeDistanceKm: 2 }), true);
  assert.equal(freeAllowed({ pricingMode: 'perKm', freeDistanceKm: 0 }), false);
  assert.equal(freeAllowed({ pricingMode: 'byValue', valueTiers: [{ minTotal: 0, fee: 1 }, { minTotal: 10, fee: 0 }] }), true);
  assert.equal(freeAllowed({ pricingMode: 'byValue', freeDistanceKm: 0, valueTiers: [{ minTotal: 0, fee: 1 }, { minTotal: 0, fee: 0, byDistance: true }] }), false);
});
