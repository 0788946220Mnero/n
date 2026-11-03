const Order = require('../models/Order');
const Customer = require('../models/Customer');
const S = require('../services/statsService');

/** الفلترة اختيارية بالعلامة؛ بدونها تُحسب كل الطلبات كما في الإحصائيات القديمة. */
const baseMatch = (req) => (req.query.brand ? { brand: String(req.query.brand) } : {});

const runRange = async (match, range) => {
  const [facet] = await Order.aggregate(
    S.buildRangePipeline({ ...match, createdAt: { $gte: range.from, $lt: range.to } })
  ).allowDiskUse(true);

  // العميل الجديد = أول طلب ناجح له (في كل الأوقات) داخل الفترة
  const phones = ((facet && facet.phones) || []).map((p) => p._id);
  let firstOrderByPhone = new Map();
  if (phones.length) {
    const firsts = await Order.aggregate(S.buildFirstOrderPipeline(phones));
    firstOrderByPhone = new Map(firsts.map((f) => [f._id, f.first]));
  }
  const shaped = S.shapeRangeResult(facet || {}, { firstOrderByPhone, from: range.from });
  delete shaped._phones;
  return shaped;
};

// GET /api/stats/overview?preset=today|yesterday|last7|last30|thisMonth|lastMonth|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
const getOverview = async (req, res) => {
  const range = S.resolveRange({ preset: req.query.preset, from: req.query.from, to: req.query.to });
  const today = S.resolveRange({ preset: 'today' });
  const match = baseMatch(req);

  const [current, todayStats, allTimeOrders, customersTotal] = await Promise.all([
    runRange(match, range),
    range.preset === 'today' ? null : runRange(match, today),
    Order.countDocuments({ ...match, status: { $ne: 'pending' } }),
    Customer.countDocuments(),
  ]);
  const t = todayStats || current;

  res.json({
    success: true,
    range: { preset: range.preset, from: range.fromYmd, to: range.toYmd, timezone: S.TZ },
    current,
    today: { orders: t.orders, value: t.value, delivery: t.delivery },
    allTime: { orders: allTimeOrders, customers: customersTotal },
    generatedAt: new Date(),
  });
};

module.exports = { getOverview };
