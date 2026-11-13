/* إعادة إنتاج خطأ الإنتاج: E11000 على key_1 { key: null } في counters أثناء البيع */
const assert = require('assert');
const Counter = require('../models/Counter');
const { allocateOrderNumber, createOrderWithNumber } = require('../utils/orderNumber');

function dupKey() { const e = new Error('E11000 duplicate key error collection: test.counters index: key_1 dup key: { key: null }'); e.code = 11000; e.keyPattern = { key: 1 }; e.keyValue = { key: null }; return e; }

(async () => {
  // قاعدة وهمية للعدّادات مع فهرس key_1 فريد حتى يُزال
  const store = new Map([['order', { _id: 'order', seq: 950 }]]);
  let indexes = [{ name: '_id_', key: { _id: 1 } }, { name: 'key_1', key: { key: 1 }, unique: true }];
  const dropped = [];
  const orig = { fb: Counter.findById, fu: Counter.findOneAndUpdate, coll: Object.getOwnPropertyDescriptor(Counter, 'collection') };
  Counter.findById = (id) => ({ lean: async () => store.get(id) || null });
  Counter.findOneAndUpdate = async (q, u) => {
    let d = store.get(q._id);
    if (!d) {
      if (indexes.some((i) => i.name === 'key_1')) throw dupKey(); // وثيقة ثانية بلا key
      d = { _id: q._id, seq: (u.$setOnInsert && u.$setOnInsert.seq) || 0 }; store.set(q._id, d);
    }
    if (u.$inc) d.seq += u.$inc.seq;
    return { ...d };
  };
  Object.defineProperty(Counter, 'collection', { configurable: true, value: { collectionName: 'counters', indexes: async () => indexes, dropIndex: async (n) => { dropped.push(n); indexes = indexes.filter((i) => i.name !== n); } } });
  try {
    const n = await allocateOrderNumber('takeaway');
    assert.deepStrictEqual(dropped, ['key_1']);
    assert.strictEqual(n.numberSeq, 951);
    assert.strictEqual(n.orderNumber, String(((951 - 1) % 400) + 1));
    const h = await allocateOrderNumber('hall');
    assert.strictEqual(h.orderNumber, '1');

    // نفس الخطأ على مجموعة الطلبات (حقل ليس في النموذج) ← يُزال ويُعاد الحفظ
    let ordIdx = [{ name: '_id_', key: { _id: 1 } }, { name: 'key_1', key: { key: 1 }, unique: true }];
    let tries = 0;
    const FakeOrder = {
      schema: require('../models/Order').schema,
      collection: { collectionName: 'orders', indexes: async () => ordIdx, dropIndex: async (n) => { ordIdx = ordIdx.filter((i) => i.name !== n); } },
      create: async (d) => { tries += 1; if (ordIdx.some((i) => i.name === 'key_1')) { const e = dupKey(); throw e; } return d; },
    };
    const o = await createOrderWithNumber(FakeOrder, 'takeaway', { total: 1 });
    assert.strictEqual(tries, 2); assert.ok(o.orderNumber);

    // فهرس فريد على حقل حقيقي في النموذج (clientRef) لا يُلمس ويُرمى الخطأ كما هو
    const FakeOrder2 = { ...FakeOrder, create: async () => { const e = new Error('E11000 clientRef'); e.code = 11000; e.keyPattern = { clientRef: 1 }; throw e; } };
    await assert.rejects(createOrderWithNumber(FakeOrder2, 'takeaway', {}), /clientRef/);
    console.log('✓ foreign unique index (key_1) self-heal');
  } finally {
    Counter.findById = orig.fb; Counter.findOneAndUpdate = orig.fu;
    if (orig.coll) Object.defineProperty(Counter, 'collection', orig.coll); else delete Counter.collection;
  }
})().catch((e) => { console.error(e); process.exit(1); });
