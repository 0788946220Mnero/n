/**
 * أرقام الفواتير الدورية: السفري+الاستلام 1…400، الصالة 1…200، التوصيل 1…200 —
 * كل سلسلة مستقلة، تدور ولا تتكرر داخل الدورة، ولا يصفّرها إغلاق الجرد، والفرادة على (السلسلة، التسلسل).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

['Counter', 'Order'].forEach((m) => require(`../models/${m}`));
const db = require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { allocateOrderNumber, seriesOf, seriesStatus } = require('../utils/orderNumber');

test('السلسلة من نوع الطلب', () => {
  assert.equal(seriesOf({ orderType: 'pickup', source: 'pos' }), 'takeaway');
  assert.equal(seriesOf({ orderType: 'pickup', source: 'web' }), 'takeaway', 'الاستلام مع السفري');
  assert.equal(seriesOf({ orderType: 'delivery', source: 'center' }), 'delivery');
  assert.equal(seriesOf({ orderType: 'dinein', source: 'hall' }), 'hall');
});

test('السفري يكمل من العدّاد القديم، والصالة والتوصيل من 1', async () => {
  await M('Counter').create({ _id: 'order', seq: 37 });
  assert.equal((await allocateOrderNumber('takeaway')).orderNumber, '38');
  assert.equal((await allocateOrderNumber('hall')).orderNumber, '1');
  assert.equal((await allocateOrderNumber({ orderType: 'delivery' })).orderNumber, '1');
  assert.equal((await allocateOrderNumber({ orderType: 'pickup' })).orderNumber, '39');
});

test('الدوران: بعد 400 سفري يعود 1، وبعد 200 صالة يعود 1 — والتسلسل الكامل لا يتكرر', async () => {
  db.reset();
  const seen = new Set();
  let last;
  for (let i = 0; i < 401; i++) {
    last = await allocateOrderNumber('takeaway');
    assert.ok(!seen.has(last.numberSeq)); seen.add(last.numberSeq);
    if (i === 399) assert.equal(last.orderNumber, '400');
  }
  assert.equal(last.orderNumber, '1'); assert.equal(last.numberSeq, 401);
  for (let i = 0; i < 200; i++) last = await allocateOrderNumber('hall');
  assert.equal(last.orderNumber, '200');
  assert.equal((await allocateOrderNumber('hall')).orderNumber, '1');
  const st = await seriesStatus();
  assert.equal(st.takeaway.next, 2); assert.equal(st.takeaway.cycleNo, 2);
  assert.equal(st.hall.next, 2); assert.equal(st.delivery.next, 1);
});

test('المتزامن: 50 طلباً معاً ← 50 رقماً مختلفاً', async () => {
  db.reset();
  const all = await Promise.all(Array.from({ length: 50 }, () => allocateOrderNumber('delivery')));
  assert.equal(new Set(all.map((x) => x.orderNumber)).size, 50);
});

test('الرقم نفسه في دورتين يُحفظ، والتسلسل المكرر يُرفض', async () => {
  db.reset();
  const base = { customerName: 'x', phone: '', address: '', items: [], itemsTotal: 1, total: 1, orderType: 'pickup', source: 'pos' };
  await M('Order').create({ ...base, orderNumber: '5', numberSeries: 'takeaway', numberSeq: 5 });
  await M('Order').create({ ...base, orderNumber: '5', numberSeries: 'takeaway', numberSeq: 405 });
  await M('Order').create({ ...base, orderNumber: '5', numberSeries: 'hall', numberSeq: 5 });
  await assert.rejects(M('Order').create({ ...base, orderNumber: '5', numberSeries: 'takeaway', numberSeq: 405 }), /E11000/);
  // الطلبات القديمة بلا تسلسل لا تتعارض
  await M('Order').create({ ...base, orderNumber: '6' });
  await M('Order').create({ ...base, orderNumber: '7' });
});

test('الإصلاح الذاتي: الفهرس الفريد القديم ما زال في القاعدة ← يُزال ويُحفظ البيع بالرقم نفسه', async () => {
  db.reset();
  const Order = M('Order');
  const { createOrderWithNumber } = require('../utils/orderNumber');
  // نحاكي القاعدة الحقيقية: فهرس فريد قديم orderNumber_1 وطلب قديم رقمه 14
  let legacy = true; let dropped = '';
  const realCreate = Order.create;
  const origIdx = Order.collection.indexes; const origDrop = Order.collection.dropIndex;
  Order.collection.indexes = async () => (legacy ? [{ name: '_id_', key: { _id: 1 } }, { name: 'orderNumber_1', key: { orderNumber: 1 }, unique: true }] : [{ name: '_id_', key: { _id: 1 } }]);
  Order.collection.dropIndex = async (n) => { dropped = n; legacy = false; };
  Order.create = async (doc) => {
    if (legacy && (await Order.exists({ orderNumber: doc.orderNumber }))) {
      throw Object.assign(new Error('E11000 duplicate key error collection: orders index: orderNumber_1 dup key'), { code: 11000, keyPattern: { orderNumber: 1 }, keyValue: { orderNumber: doc.orderNumber } });
    }
    return realCreate.call(Order, doc);
  };
  try {
    const base = { customerName: 'x', phone: '', address: '', items: [], itemsTotal: 1, total: 1, orderType: 'pickup', source: 'pos' };
    await realCreate.call(Order, { ...base, orderNumber: '14' }); // طلب قديم
    await M('Counter').create({ _id: 'order:takeaway', seq: 413 }); // التالي 414 ← يظهر 14
    const o = await createOrderWithNumber(Order, 'takeaway', base);
    assert.equal(o.orderNumber, '14');
    assert.equal(dropped, 'orderNumber_1');
    assert.equal(await Order.countDocuments({ orderNumber: '14' }), 2);
    // تصادم آخر (clientRef مثلاً) لا يُبتلع
    Order.create = async () => { throw Object.assign(new Error('E11000 clientRef'), { code: 11000, keyPattern: { clientRef: 1 } }); };
    await assert.rejects(createOrderWithNumber(Order, 'takeaway', base), /clientRef/);
  } finally {
    Order.create = realCreate; Order.collection.indexes = origIdx; Order.collection.dropIndex = origDrop;
  }
});
