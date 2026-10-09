/**
 * خدمة الإحصائيات — كل الأرقام من قاعدة البيانات مباشرة بالتجميع (aggregation)،
 * فلا تُجلب الطلبات إلى الخادم ولا تُستخدم أرقام ثابتة.
 *
 * التعريفات (موحّدة مع الجرد):
 *  • الطلب «المعلّق» (pending) طلب موقع لم يؤكده أحد: يظهر في «حسب الحالة» فقط ولا يدخل الأرقام.
 *  • الناجح: كل طلب مؤكَّد غير ملغى.
 *  • قيد التنفيذ: طلب منصة ناجح لم يُسلَّم بعد (new/preparing/ready/out_for_delivery).
 *  • المكتمل: طلب منصة سُلِّم، أو بيع سفري (يكتمل لحظة بيعه).
 *  • القيمة: قيمة الأصناف بدون رسوم التوصيل (رسوم التوصيل للمندوبين، تُعرض منفصلة).
 */

const TZ = process.env.STATS_TIMEZONE || 'Asia/Amman';
const TZ_OFFSET = process.env.STATS_TZ_OFFSET || '+03:00'; // الأردن على +03:00 طوال العام

const IN_PROGRESS = ['new', 'preparing', 'ready', 'out_for_delivery'];

/** حدود يوم محلي (YYYY-MM-DD) كتواريخ UTC. */
const dayStart = (ymd) => new Date(`${ymd}T00:00:00.000${TZ_OFFSET}`);

const localYmd = (date = new Date()) => {
  // تاريخ اليوم بتوقيت المطعم
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
    .reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * يحوّل اسم فترة (أو نطاقاً مخصصاً) إلى { from, to, fromYmd, toYmd } — to حصري.
 * presets: today | yesterday | last7 | last30 | thisMonth | lastMonth | custom
 */
const resolveRange = ({ preset = 'today', from, to } = {}) => {
  const today = localYmd();
  let a;
  let b; // b شامل
  switch (preset) {
    case 'yesterday': a = addDays(today, -1); b = a; break;
    case 'last7': a = addDays(today, -6); b = today; break;
    case 'last30': a = addDays(today, -29); b = today; break;
    case 'thisMonth': a = `${today.slice(0, 7)}-01`; b = today; break;
    case 'lastMonth': {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThis, -1);
      a = `${lastPrev.slice(0, 7)}-01`;
      b = lastPrev;
      break;
    }
    case 'custom': {
      const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
      a = ok(from) ? from : today;
      b = ok(to) ? to : a;
      if (b < a) [a, b] = [b, a];
      break;
    }
    case 'today':
    default: a = today; b = today;
  }
  return { from: dayStart(a), to: dayStart(addDays(b, 1)), fromYmd: a, toYmd: b, preset };
};

const salesValueExpr = { $subtract: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$deliveryFee', 0] }] };
const isSuccess = { $and: [{ $ne: ['$status', 'pending'] }, { $ne: ['$status', 'cancelled'] }] };
const isPos = { $eq: ['$source', 'pos'] };
const isCenter = { $eq: ['$source', 'center'] };
const isDelivery = { $and: [{ $ne: ['$source', 'pos'] }, { $eq: ['$orderType', 'delivery'] }] };

/** خط التجميع لفترة: كل البطاقات والمخططات في استعلام واحد ($facet). */
const buildRangePipeline = (match) => [
  { $match: match },
  {
    $facet: {
      totals: [
        {
          $group: {
            _id: null,
            counted: { $sum: { $cond: [{ $ne: ['$status', 'pending'] }, 1, 0] } },
            success: { $sum: { $cond: [isSuccess, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            inProgress: {
              $sum: { $cond: [{ $and: [{ $not: [isPos] }, { $in: ['$status', IN_PROGRESS] }] }, 1, 0] },
            },
            completed: {
              $sum: {
                $cond: [
                  { $or: [{ $eq: ['$status', 'delivered'] }, { $and: [isPos, { $ne: ['$status', 'cancelled'] }] }] },
                  1, 0,
                ],
              },
            },
            value: { $sum: { $cond: [isSuccess, salesValueExpr, 0] } },
            gross: { $sum: { $cond: [isSuccess, { $ifNull: ['$total', 0] }, 0] } },
            deliveryCount: { $sum: { $cond: [{ $and: [isSuccess, isDelivery] }, 1, 0] } },
            deliveryValue: { $sum: { $cond: [{ $and: [isSuccess, isDelivery] }, salesValueExpr, 0] } },
            deliveryFees: { $sum: { $cond: [{ $and: [isSuccess, isDelivery] }, { $ifNull: ['$deliveryFee', 0] }, 0] } },
            posCount: { $sum: { $cond: [{ $and: [isSuccess, isPos] }, 1, 0] } },
            posValue: { $sum: { $cond: [{ $and: [isSuccess, isPos] }, salesValueExpr, 0] } },
            centerCount: { $sum: { $cond: [{ $and: [isSuccess, isCenter] }, 1, 0] } },
            centerValue: { $sum: { $cond: [{ $and: [isSuccess, isCenter] }, salesValueExpr, 0] } },
            cashValue: { $sum: { $cond: [{ $and: [isSuccess, { $eq: [{ $ifNull: ['$paymentMethod', 'cash'] }, 'cash'] }] }, salesValueExpr, 0] } },
            cliqValue: { $sum: { $cond: [{ $and: [isSuccess, { $eq: ['$paymentMethod', 'cliq'] }] }, salesValueExpr, 0] } },
            cardValue: { $sum: { $cond: [{ $and: [isSuccess, { $in: ['$paymentMethod', ['card', 'online']] }] }, salesValueExpr, 0] } },
          },
        },
      ],
      byStatus: [
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: salesValueExpr } } },
        { $sort: { count: -1 } },
      ],
      byDay: [
        { $match: { status: { $nin: ['pending', 'cancelled'] } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } },
            count: { $sum: 1 },
            value: { $sum: salesValueExpr },
            deliveryFees: { $sum: { $ifNull: ['$deliveryFee', 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ],
      byHour: [
        { $match: { status: { $nin: ['pending', 'cancelled'] } } },
        {
          $group: {
            _id: { $hour: { date: '$createdAt', timezone: TZ } },
            count: { $sum: 1 },
            value: { $sum: salesValueExpr },
          },
        },
        { $sort: { _id: 1 } },
      ],
      topItems: [
        { $match: { status: { $nin: ['pending', 'cancelled'] } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.nameAr',
            quantity: { $sum: { $ifNull: ['$items.quantity', 1] } },
            value: { $sum: { $multiply: [{ $ifNull: ['$items.price', 0] }, { $ifNull: ['$items.quantity', 1] }] } },
          },
        },
        { $sort: { quantity: -1, value: -1 } },
        { $limit: 10 },
      ],
      phones: [
        { $match: { status: { $nin: ['pending', 'cancelled'] }, source: { $ne: 'pos' }, phone: { $nin: [null, ''] } } },
        { $group: { _id: '$phone' } },
      ],
    },
  },
];

const r3 = (n) => Number(Number(n || 0).toFixed(3));

/** يحوّل ناتج $facet إلى شكل واجهة الإحصائيات. */
const shapeRangeResult = (facet, { firstOrderByPhone = new Map(), from } = {}) => {
  const t = (facet.totals && facet.totals[0]) || {};
  const phones = (facet.phones || []).map((p) => p._id);
  let newCustomers = 0;
  for (const ph of phones) {
    const first = firstOrderByPhone.get(ph);
    if (!first || first >= from) newCustomers += 1;
  }
  const success = t.success || 0;
  return {
    orders: {
      total: t.counted || 0,
      success,
      inProgress: t.inProgress || 0,
      completed: t.completed || 0,
      cancelled: t.cancelled || 0,
      pending: t.pending || 0,
    },
    value: {
      sales: r3(t.value),                  // بدون توصيل
      gross: r3(t.gross),                  // شامل التوصيل
      average: success ? r3(t.value / success) : 0,
      cash: r3(t.cashValue),
      cliq: r3(t.cliqValue),
      card: r3(t.cardValue),
      other: r3((t.value || 0) - (t.cashValue || 0)),
    },
    delivery: { count: t.deliveryCount || 0, value: r3(t.deliveryValue), fees: r3(t.deliveryFees) },
    pos: { count: t.posCount || 0, value: r3(t.posValue) },
    center: { count: t.centerCount || 0, value: r3(t.centerValue) },
    customers: {
      active: phones.length,
      new: newCustomers,
      returning: Math.max(0, phones.length - newCustomers),
    },
    byStatus: (facet.byStatus || []).map((s) => ({ status: s._id, count: s.count, value: r3(s.value) })),
    byDay: (facet.byDay || []).map((d) => ({ day: d._id, count: d.count, value: r3(d.value), deliveryFees: r3(d.deliveryFees) })),
    byHour: (facet.byHour || []).map((h) => ({ hour: h._id, count: h.count, value: r3(h.value) })),
    topItems: (facet.topItems || []).map((i) => ({ name: i._id || '—', quantity: i.quantity, value: r3(i.value) })),
    _phones: phones,
  };
};

/** أول طلب لكل رقم (كل الأوقات) — لتمييز العميل الجديد عن العائد. */
const buildFirstOrderPipeline = (phones) => [
  { $match: { phone: { $in: phones }, status: { $nin: ['pending', 'cancelled'] } } },
  { $group: { _id: '$phone', first: { $min: '$createdAt' } } },
];

module.exports = {
  TZ,
  resolveRange,
  localYmd,
  addDays,
  buildRangePipeline,
  shapeRangeResult,
  buildFirstOrderPipeline,
};
