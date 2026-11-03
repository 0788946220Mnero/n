/*
  اختبار تسعير طلب الموقع (POST /api/orders) — بلا قاعدة بيانات:
  تُستبدل دوال النماذج بنسخ وهمية، ويُستدعى createOrder مباشرة.
  التشغيل: npm test
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const BlockedPhone = require('../models/BlockedPhone');
const Setting = require('../models/Setting');
const orderNumber = require('../utils/orderNumber');
const realtime = require('../services/realtimeService');
const pushService = require('../services/pushService');

// ── قاعدة بيانات وهمية ──
const SHAWARMA = new mongoose.Types.ObjectId();
const MANSAF = new mongoose.Types.ObjectId();
const STOPPED = new mongoose.Types.ObjectId();
const DB = [
  { _id: SHAWARMA, nameAr: 'شاورما', price: 3.5, isAvailable: true, printerName: 'مطبخ',
    addons: [{ name: 'جبنة', price: 0.25 }, { name: 'بطاطا', price: 0.5 }] },
  { _id: MANSAF, nameAr: 'منسف', price: 9, isAvailable: true, printerName: 'مطبخ', addons: [] },
  { _id: STOPPED, nameAr: 'كنافة', price: 2, isAvailable: false, printerName: '', addons: [] },
];
const chain = (rows) => ({ select() { return this; }, lean: async () => rows, then: (r) => r(rows) });
Product.find = (q) => {
  const ids = ((q && q._id && q._id.$in) || []).map(String);
  return chain(DB.filter((p) => ids.includes(String(p._id)) && (q.isAvailable === undefined || p.isAvailable === q.isAvailable)));
};
let created = null;
Order.findOne = () => ({ select: async () => null });
Order.create = async (doc) => { created = doc; return { ...doc, _id: new mongoose.Types.ObjectId() }; };
Customer.findOne = async () => null;
Customer.create = async () => ({});
BlockedPhone.findOne = async () => null;
Setting.findOne = async () => ({ delivery: { enabled: true } });
orderNumber.generateUniqueOrderNumber = async () => 'T-1';
realtime.emitOrderCreated = () => {};
pushService.notifyNewOrder = async () => {};

// يُحمَّل المتحكّم بعد استبدال الدوال حتى يلتقط النسخ الوهمية
const { createOrder } = require('../controllers/orderController');
const { priceOrderItems } = require('../services/pricingService');

const call = async (body) => {
  created = null;
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await createOrder({ body: { customerName: 'زبون', phone: '0791234567', total: 1, orderType: 'pickup', ...body } }, res, () => {});
  return res;
};

test('طلب طبيعي: السعر من القاعدة مع الإضافات المعرّفة', async () => {
  const r = await call({ items: [{ product: String(SHAWARMA), nameAr: 'شاورما', quantity: 2, price: 3.75, addons: [{ name: 'جبنة', price: 0.25 }] }] });
  assert.equal(r.code, 201);
  assert.equal(created.items[0].price, 3.75);
  assert.equal(created.itemsTotal, 7.5);
  assert.equal(created.total, 7.5);
  assert.equal(created.items[0].printerName, 'مطبخ');
});

test('سعر الصنف القادم من الجهاز يُتجاهل', async () => {
  const r = await call({ items: [{ product: String(MANSAF), nameAr: 'منسف', quantity: 1, price: 0.1 }] });
  assert.equal(r.code, 201);
  assert.equal(created.total, 9);
});

test('ثغرة 1: إضافة غير معرّفة بسعر سالب تُحذف', async () => {
  const r = await call({ items: [{ product: String(SHAWARMA), quantity: 1, addons: [{ name: 'خصم', price: -3 }] }] });
  assert.equal(r.code, 201);
  assert.deepEqual(created.items[0].addons, []);
  assert.equal(created.total, 3.5);
});

test('سعر الإضافة المعرّفة من القاعدة لا من الجهاز', async () => {
  await call({ items: [{ product: String(SHAWARMA), quantity: 1, addons: [{ name: 'بطاطا', price: -10 }] }] });
  assert.equal(created.items[0].addons[0].price, 0.5);
  assert.equal(created.total, 4);
});

test('الإضافة المكرّرة تُحسب مرة واحدة', async () => {
  await call({ items: [{ product: String(SHAWARMA), quantity: 1, addons: [{ name: 'جبنة' }, { name: 'جبنة' }] }] });
  assert.equal(created.total, 3.75);
});

test('ثغرة 2: صنف بلا رقم منتج يُرفض بـ 409 (الموقع يعرض الرسالة ولا يكمل)', async () => {
  const r = await call({ items: [{ nameAr: 'منسف كبير', quantity: 1, price: 0.1 }] });
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'ITEM_NOT_FOUND');
  assert.equal(created, null);
});

test('صنف برقم منتج غير موجود يُرفض', async () => {
  const r = await call({ items: [{ product: String(new mongoose.Types.ObjectId()), nameAr: 'محذوف', quantity: 1 }] });
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'ITEM_NOT_FOUND');
});

test('ثغرة 3: الكمية السالبة تصبح 1 والكبيرة تُحصر بـ 999', async () => {
  await call({ items: [{ product: String(MANSAF), quantity: -5 }] });
  assert.equal(created.items[0].quantity, 1);
  assert.equal(created.total, 9);
  await call({ items: [{ product: String(MANSAF), quantity: 100000 }] });
  assert.equal(created.items[0].quantity, 999);
});

test('صنف موقوف يُرفض برسالته المعتادة', async () => {
  const r = await call({ items: [{ product: String(STOPPED), quantity: 1 }] });
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'ITEM_UNAVAILABLE');
  assert.match(r.body.message, /كنافة/);
});

test('اسم الصنف من القاعدة لا من الجهاز', async () => {
  await call({ items: [{ product: String(MANSAF), nameAr: 'هدية مجانية', quantity: 1 }] });
  assert.equal(created.items[0].nameAr, 'منسف');
});

test('priceOrderItems: قائمة فارغة', async () => {
  const r = await priceOrderItems([]);
  assert.equal(r.code, 'NO_ITEMS');
});
