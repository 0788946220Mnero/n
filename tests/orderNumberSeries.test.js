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
