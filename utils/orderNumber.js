const Counter = require('../models/Counter');

/*
  ═══════════════════════════════════════════════════════════════
  أرقام الفواتير — سلسلة مستقلة لكل نوع، تدور ولا تتكرر داخل الدورة:

    takeaway  السفري + الاستلام (بيع الكاشير، استلام المنصة، استلام السنتر)  1 … 400 ثم 1
    hall      الصالة (طلبات الطاولات عند القبض)                              1 … 200 ثم 1
    delivery  التوصيل (المنصة، السنتر)                                        1 … 200 ثم 1

  • العدّاد ذرّي ($inc) ولا يرتبط بالجرد: إغلاق الجرد لا يصفّره، والرقم يكمل.
  • numberSeq: التسلسل الكامل للسلسلة (لا يدور أبداً) — وفهرس فريد على (السلسلة، التسلسل)
    يمنع أي تكرار مهما تزامنت الطلبات. orderNumber هو الرقم الظاهر على الفاتورة.
  • ORDER_NUMBER_PREFIX اختياري: «ORD-» ← ORD-17
  • الحدود قابلة للضبط: ORDER_CYCLE_TAKEAWAY / ORDER_CYCLE_HALL / ORDER_CYCLE_DELIVERY
  ═══════════════════════════════════════════════════════════════
*/

const PREFIX = process.env.ORDER_NUMBER_PREFIX || '';
const envInt = (k, d) => { const n = parseInt(process.env[k], 10); return n > 0 ? n : d; };
const SERIES = {
  takeaway: { cycle: envInt('ORDER_CYCLE_TAKEAWAY', 400), label: 'سفري واستلام' },
  hall: { cycle: envInt('ORDER_CYCLE_HALL', 200), label: 'الصالة' },
  delivery: { cycle: envInt('ORDER_CYCLE_DELIVERY', 200), label: 'التوصيل' },
};

// يستخرج الجزء الرقمي من أي رقم طلب قديم: "52" → 52 | "ORD-15150313" → 15150313
const numericPart = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

/** سلسلة الطلب من نوعه ومصدره. */
function seriesOf({ orderType, source } = {}) {
  if (orderType === 'dinein' || source === 'hall') return 'hall';
  if (orderType === 'delivery') return 'delivery';
  return 'takeaway';
}

/**
 * أول تشغيل: السفري يكمل من العدّاد القديم الموحّد (فلا تعود فواتير اليوم إلى 1 فجأة)،
 * والصالة والتوصيل يبدآن من 1.
 */
async function seed(series) {
  const id = `order:${series}`;
  if (await Counter.findById(id).lean()) return;
  let start = 0;
  if (series === 'takeaway') {
    const old = await Counter.findById('order').lean();
    if (old && old.seq > 0) start = old.seq;
  }
  await Counter.findOneAndUpdate({ _id: id }, { $setOnInsert: { seq: start } }, { upsert: true, new: true });
}

/**
 * يحجز الرقم التالي للسلسلة. يرجع الحقول التي تُحفظ في الطلب:
 *   { orderNumber: '17', numberSeries: 'takeaway', numberSeq: 417 }
 */
async function allocateOrderNumber(kind = {}) {
  const series = typeof kind === 'string' ? kind : seriesOf(kind);
  const cfg = SERIES[series] || SERIES.takeaway;
  let c;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await seed(series);
      c = await Counter.findOneAndUpdate({ _id: `order:${series}` }, { $inc: { seq: 1 } }, { new: true, upsert: true });
      break;
    } catch (e) {
      // فهرس فريد غريب على مجموعة العدّادات (مثل key_1 من نسخة/تطبيق قديم) يرفض العدّاد الجديد
      if (e && e.code === 11000 && attempt < 2 && !isIdDup(e)) { await dropForeignUnique(Counter); continue; }
      throw e;
    }
  }
  const seq = c.seq;
  const shown = ((seq - 1) % cfg.cycle) + 1;
  return { orderNumber: `${PREFIX}${shown}`, numberSeries: series, numberSeq: seq };
}

/**
 * ينشئ الطلب برقم من سلسلته — ويصلح نفسه عند التصادم بدل أن يفشل البيع:
 *   • تصادم على orderNumber: الفهرس الفريد القديم ما زال في القاعدة ← يُزال فوراً ثم يُعاد الحفظ بالرقم نفسه
 *   • تصادم على numberSeq: (نادر) يُحجز الرقم التالي
 * أي تصادم آخر (clientRef مثلاً) يُرمى كما هو ليتعامل معه المتحكّم.
 */
async function createOrderWithNumber(Order, kind, data) {
  let numbering = await allocateOrderNumber(kind);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await Order.create({ ...data, ...numbering });
    } catch (e) {
      if (!e || e.code !== 11000) throw e;
      const key = Object.keys(e.keyPattern || e.keyValue || {});
      const msg = String(e.message || '');
      if (key.includes('orderNumber') || /orderNumber_1/.test(msg)) {
        await dropLegacyUnique(Order);
        continue;
      }
      if (key.includes('numberSeq') || /order_number_series/.test(msg)) { numbering = await allocateOrderNumber(kind); continue; }
      // فهرس فريد على حقل غير موجود في نموذج الطلب (مثل key_1) ← يُزال ثم يُعاد الحفظ
      if (key.length && !key.some((k) => Order.schema.path(k))) { await dropForeignUnique(Order); continue; }
      throw e;
    }
  }
  throw new Error('تعذّر حجز رقم فاتورة');
}

let dropping = null;
/** يزيل أي فهرس فريد على orderNumber وحده (من النسخة القديمة). */
async function dropLegacyUnique(Order) {
  if (!dropping) {
    dropping = (async () => {
      try {
        const idx = await Order.collection.indexes();
        for (const i of idx) {
          if (i.unique && i.key && Object.keys(i.key).length === 1 && i.key.orderNumber) {
            await Order.collection.dropIndex(i.name);
            console.log(`🔢 أُزيل الفهرس الفريد القديم ${i.name} — أرقام الفواتير تدور الآن`);
          }
        }
      } catch (err) {
        console.error('dropLegacyUnique:', err.message);
      } finally { setTimeout(() => { dropping = null; }, 5000); }
    })();
  }
  return dropping;
}

function isIdDup(e) {
  const k = Object.keys((e && (e.keyPattern || e.keyValue)) || {});
  return k.length === 1 && k[0] === '_id';
}

/**
 * يزيل أي فهرس فريد على حقول لا يعرفها النموذج إطلاقاً (بقايا نسخة قديمة أو تطبيق آخر).
 * مثال حقيقي من الإنتاج: key_1 على counters — كل وثيقة بلا key تُعدّ key:null فيُرفض العدّاد الثاني.
 * فهارس حقول النموذج نفسه لا تُلمس.
 */
const foreignDropping = new Map();
async function dropForeignUnique(Model) {
  const name = Model.collection.collectionName;
  if (!foreignDropping.has(name)) {
    foreignDropping.set(name, (async () => {
      try {
        const idx = await Model.collection.indexes();
        for (const i of idx) {
          if (!i.unique || !i.key || i.name === '_id_') continue;
          const fields = Object.keys(i.key);
          if (fields.some((f) => f === '_id' || Model.schema.path(f))) continue;
          await Model.collection.dropIndex(i.name);
          console.log(`🧹 أُزيل فهرس فريد غريب ${name}.${i.name} (حقول ليست في النموذج: ${fields.join(', ')})`);
        }
      } catch (err) {
        if (!(err && err.codeName === 'NamespaceNotFound')) console.error(`dropForeignUnique ${name}:`, err.message);
      } finally { setTimeout(() => foreignDropping.delete(name), 5000); }
    })());
  }
  return foreignDropping.get(name);
}

/** توافق مع الكود القديم: الرقم الظاهر فقط (سلسلة السفري). */
const generateUniqueOrderNumber = async (kind) => (await allocateOrderNumber(kind || 'takeaway')).orderNumber;

/** حالة السلاسل (للإعدادات/الاختبارات): التالي في كل سلسلة. */
async function seriesStatus() {
  const out = {};
  for (const [k, v] of Object.entries(SERIES)) {
    const c = await Counter.findById(`order:${k}`).lean();
    const seq = c ? c.seq : 0;
    out[k] = { label: v.label, cycle: v.cycle, next: (seq % v.cycle) + 1, cycleNo: Math.floor(seq / v.cycle) + 1 };
  }
  return out;
}

module.exports = {
  dropForeignUnique, createOrderWithNumber, dropLegacyUnique, allocateOrderNumber, generateUniqueOrderNumber, numericPart, seriesOf, seriesStatus, SERIES };
