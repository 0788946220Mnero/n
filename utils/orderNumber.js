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
  await seed(series);
  const c = await Counter.findOneAndUpdate({ _id: `order:${series}` }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const seq = c.seq;
  const shown = ((seq - 1) % cfg.cycle) + 1;
  return { orderNumber: `${PREFIX}${shown}`, numberSeries: series, numberSeq: seq };
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

module.exports = { allocateOrderNumber, generateUniqueOrderNumber, numericPart, seriesOf, seriesStatus, SERIES };
