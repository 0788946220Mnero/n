const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Setting = require('../models/Setting');
const { deliveryState, deliveryStateFilter, DELIVERY_STATES, DELIVERY_BASE } = require('../utils/deliveryState');

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dayStart = (ymd) => new Date(`${ymd}T00:00:00+03:00`);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const salesValue = (o) => Math.max(0, Number(o.total || 0) - Number(o.deliveryFee || 0));
const r3 = (n) => Number(Number(n || 0).toFixed(3));

/** إحداثيات صالحة فقط — لا نخمّن ولا نضع علامة وهمية. */
const validCoords = (lat, lng) =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);

const minutesBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);

/** سجل توصيل لطلب — كل الحقول من الطلب نفسه (لا نسخة مكررة في قاعدة البيانات). */
const deliveryRecord = (o) => ({
  _id: o._id,
  orderNumber: o.orderNumber,
  customerName: o.customerName || '',
  phone: o.phone || '',
  address: o.address || '',
  latitude: validCoords(o.customerLatitude, o.customerLongitude) ? o.customerLatitude : null,
  longitude: validCoords(o.customerLatitude, o.customerLongitude) ? o.customerLongitude : null,
  driver: o.driver || null,
  driverName: o.driverName || '',
  status: o.status,
  deliveryState: deliveryState(o),
  createdAt: o.createdAt,
  confirmedAt: o.confirmedAt || null,
  driverAssignedAt: o.driverAssignedAt || null,
  deliverySentAt: o.deliverySentAt || null,
  outForDeliveryAt: o.outForDeliveryAt || null,
  deliveredAt: o.deliveredAt || null,
  cancelledAt: o.cancelledAt || null,
  itemsValue: r3(salesValue(o)),
  deliveryFee: r3(o.deliveryFee),
  total: r3(o.total),
  paymentMethod: o.paymentMethod || 'cash',
  distanceKm: o.deliveryDistance != null ? o.deliveryDistance : null,
  // المدد بالدقائق حين تتوفر اللحظتان فعلاً
  durations: {
    totalMinutes: minutesBetween(o.createdAt, o.deliveredAt),
    fromOutMinutes: minutesBetween(o.outForDeliveryAt, o.deliveredAt),
    fromAssignMinutes: minutesBetween(o.driverAssignedAt, o.deliveredAt),
  },
  closed: !!o.closed,
});

const rangeFilter = (q, field = 'createdAt') => {
  if (!isYmd(q.from) && !isYmd(q.to)) return {};
  const f = {};
  if (isYmd(q.from)) f.$gte = dayStart(q.from);
  if (isYmd(q.to)) f.$lt = new Date(dayStart(q.to).getTime() + 86400000);
  return { [field]: f };
};

/* ─────────── الخريطة ─────────── */

// GET /api/delivery/map — كل طلبات التوصيل الجارية (+ ما انتهى خلال آخر 12 ساعة لفلاتر «تم التسليم/ملغي»)
const getMap = async (req, res) => {
  const now = Date.now();
  const filter = {
    ...DELIVERY_BASE,
    $or: [
      // الجارية: آخر 3 أيام (طلب نُسي بلا «تم التسليم» لا يبقى على الخريطة للأبد)
      { status: { $nin: ['delivered', 'cancelled'] }, createdAt: { $gte: new Date(now - 3 * 86400000) } },
      { status: 'delivered', deliveredAt: { $gte: new Date(now - 12 * 3600000) } },
      { status: 'cancelled', cancelledAt: { $gte: new Date(now - 12 * 3600000) } },
    ],
  };
  const [orders, settings] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).limit(500).lean(),
    Setting.findOne().select('delivery.restaurantLatitude delivery.restaurantLongitude').lean(),
  ]);
  const d = (settings && settings.delivery) || {};
  res.json({
    success: true,
    restaurant: validCoords(d.restaurantLatitude, d.restaurantLongitude)
      ? { latitude: d.restaurantLatitude, longitude: d.restaurantLongitude } : null,
    data: orders.map(deliveryRecord),
    states: DELIVERY_STATES,
  });
};

/* ─────────── سجل التوصيل ─────────── */

// GET /api/delivery/history?from&to&driver&state&q&page&limit — من الأحدث للأقدم
const getHistory = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const filter = { ...DELIVERY_BASE, ...rangeFilter(req.query) };
  if (req.query.driver === 'none') filter.driver = null;
  else if (req.query.driver && mongoose.Types.ObjectId.isValid(req.query.driver)) filter.driver = req.query.driver;
  const sf = req.query.state ? deliveryStateFilter(req.query.state) : null;
  if (sf) Object.assign(filter, sf);
  if (req.query.q) {
    const rx = { $regex: escRx(String(req.query.q).trim()), $options: 'i' };
    filter.$or = [{ orderNumber: rx }, { customerName: rx }, { phone: rx }, { driverName: rx }, { address: rx }];
  }
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  res.json({ success: true, data: orders.map(deliveryRecord), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

/* ─────────── موظفو التوصيل ─────────── */

const salesExpr = { $subtract: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$deliveryFee', 0] }] };

/** تجميع لكل مندوب في الفترة: استلم، سلّم، أُلغي، جارية، قيم. */
const driverStatsPipeline = (match) => [
  { $match: match },
  {
    $group: {
      _id: '$driver',
      received: { $sum: 1 },
      delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      active: { $sum: { $cond: [{ $in: ['$status', ['new', 'preparing', 'ready', 'out_for_delivery']] }, 1, 0] } },
      deliveredValue: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, salesExpr, 0] } },
      deliveredFees: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, { $ifNull: ['$deliveryFee', 0] }, 0] } },
      lastAt: { $max: '$createdAt' },
    },
  },
];

const shapeDriverStats = (row) => ({
  received: row ? row.received : 0,
  delivered: row ? row.delivered : 0,
  cancelled: row ? row.cancelled : 0,
  active: row ? row.active : 0,
  deliveredValue: r3(row && row.deliveredValue),
  deliveredFees: r3(row && row.deliveredFees),
  lastAt: row ? row.lastAt : null,
});

// GET /api/delivery/drivers?from&to — كل موظفي التوصيل مع أرقامهم في الفترة
const getDrivers = async (req, res) => {
  const drivers = await User.find({ role: 'delivery' }).select('name username phone isActive createdAt').sort('name').lean();
  const rows = await Order.aggregate(driverStatsPipeline({ ...DELIVERY_BASE, driver: { $ne: null }, ...rangeFilter(req.query) }));
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  res.json({
    success: true,
    data: drivers.map((d) => ({ ...d, stats: shapeDriverStats(byId.get(String(d._id))) })),
  });
};

// GET /api/delivery/drivers/:id?from&to&page — سجل مندوب: أرقامه، طلباته الحالية، وطلباته السابقة
const getDriver = async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const driver = await User.findOne({ _id: id, role: 'delivery' }).select('name username phone isActive createdAt').lean();
  if (!driver) return res.status(404).json({ message: 'موظف التوصيل غير موجود' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const base = { ...DELIVERY_BASE, driver: driver._id };
  const range = rangeFilter(req.query);
  const pastFilter = { ...base, ...range, status: { $in: ['delivered', 'cancelled'] } };

  const [rows, current, past, pastTotal] = await Promise.all([
    Order.aggregate(driverStatsPipeline({ ...base, ...range })),
    Order.find({ ...base, status: { $in: ['new', 'preparing', 'ready', 'out_for_delivery'] } }).sort({ createdAt: -1 }).limit(100).lean(),
    Order.find(pastFilter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(pastFilter),
  ]);

  res.json({
    success: true,
    driver,
    stats: shapeDriverStats(rows[0]),
    current: current.map(deliveryRecord),
    past: past.map(deliveryRecord),
    pagination: { page, limit, total: pastTotal, pages: Math.ceil(pastTotal / limit) },
  });
};

module.exports = { getMap, getHistory, getDrivers, getDriver, driverStatsPipeline, deliveryRecord, validCoords };
