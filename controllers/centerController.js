/**
 * «بيع سنتر» — طلبات هاتفية يُدخلها موظف باسم الزبون ورقمه، من أي مكان.
 *
 *   • موظف سنتر (دور center، غالباً من المنزل): الطلب يصل المطعم «معلّقاً» تماماً
 *     كطلب المنصة — تنبيه، قسائم المطبخ تلقائياً، والكاشير يؤكّد ويطبع فيدخل جرده.
 *     موظف السنتر لا يمسك نقداً فلا يدخل الطلب جرده أبداً.
 *   • موظف داخل المطعم (كاشير/مدير/موظف): يُؤكَّد فوراً ويدخل جرده، ويُطبع كالسفري.
 *   • الأسعار ورسوم التوصيل من الخادم دائماً (نفس قواعد المنصة).
 *   • سجل الزبون واحد برقمه: طلبات المنصة والسنتر معاً.
 */
const mongoose = require('mongoose');
const crypto = require('crypto');
const { wrapAll } = require('../utils/asyncHandler');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Setting = require('../models/Setting');
const BlockedPhone = require('../models/BlockedPhone');
const PresenceSession = require('../models/PresenceSession');
const User = require('../models/User');
const realtime = require('../services/realtimeService');
const pushService = require('../services/pushService');
const printerService = require('../services/printerService');
const presence = require('../services/presenceService');
const { generateUniqueOrderNumber } = require('../utils/orderNumber');
const { quoteDelivery, feeForValue } = require('../services/deliveryFeeService');
const { logActivity } = require('../utils/activity');
const { touchOpenSession } = require('../services/shiftService');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const r3 = (n) => Number(Number(n || 0).toFixed(3));
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dayStart = (ymd) => new Date(`${ymd}T00:00:00+03:00`);
const todayYmd = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const salesValue = (o) => Math.max(0, Number(o.total || 0) - Number(o.deliveryFee || 0));

/** 07XXXXXXXX من أي صيغة (+9627…، 9627…، مسافات وشرطات) — أو '' إن لم يكن رقماً أردنياً صالحاً. */
const normPhone = (raw) => {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('00962')) d = d.slice(5);
  else if (d.startsWith('962')) d = d.slice(3);
  if (d.length === 9 && d.startsWith('7')) d = `0${d}`;
  return /^07\d{8}$/.test(d) ? d : '';
};
const phoneVariants = (local) => [local, `+962${local.slice(1)}`, `962${local.slice(1)}`];

/** تسعير الأصناف من القاعدة (كالسفري): السعر + إضافاته المعرّفة، وطابعة كل قسم. */
const priceItems = async (items) => {
  const ids = items.map((i) => i.product).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const out = [];
  const off = [];
  for (const it of items) {
    const p = byId.get(String(it.product));
    if (!p) return { error: `صنف غير موجود: ${it.nameAr || it.product}` };
    if (p.isAvailable === false) { off.push(p.nameAr); continue; }
    const quantity = Math.min(999, Math.max(parseInt(it.quantity, 10) || 1, 1));
    const known = new Map((p.addons || []).map((a) => [String(a.name || '').trim(), Number(a.price || 0)]));
    const addons = (Array.isArray(it.addons) ? it.addons : [])
      .map((a) => String((a && a.name) || '').trim()).filter((n) => known.has(n))
      .map((n) => ({ name: n, price: known.get(n) }));
    out.push({
      product: p._id, nameAr: p.nameAr, quantity,
      price: r3(Number(p.price || 0) + addons.reduce((t, a) => t + a.price, 0)),
      addons, notes: String(it.notes || '').slice(0, 120), printerName: '',
    });
  }
  if (off.length) return { error: `غير متوفر حالياً: ${off.join('، ')}`, code: 'ITEM_UNAVAILABLE' };
  if (!out.length) return { error: 'لا توجد أصناف في الطلب' };
  try {
    const groups = await printerService.groupOrderItemsByPrinter(out);
    for (const g of groups) for (const i of g.items) i.printerName = g.printer ? g.printer.name : '';
  } catch (_) { /* الطابعات لا تُفشل الطلب */ }
  return { items: out, itemsTotal: r3(out.reduce((t, i) => t + i.price * i.quantity, 0)) };
};

// POST /api/center/orders
const createOrder = async (req, res) => {
  const b = req.body || {};
  const user = req.user;
  const isAgent = user.role === 'center';

  const phone = normPhone(b.phone);
  if (!phone) return res.status(400).json({ success: false, code: 'INVALID_PHONE', message: 'رقم الزبون غير صحيح — 10 أرقام يبدأ بـ 07' });
  const customerName = String(b.customerName || '').trim().slice(0, 80);
  if (!customerName) return res.status(400).json({ success: false, message: 'اكتب اسم الزبون' });
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ success: false, message: 'لا توجد أصناف في الطلب' });
  const orderType = b.orderType === 'delivery' ? 'delivery' : 'pickup';

  // إعادة الإرسال بعد انقطاع الشبكة لا تُنشئ طلباً ثانياً
  const clientRef = String(b.clientRef || '').trim().slice(0, 64);
  if (clientRef) {
    const dup = await Order.findOne({ clientRef, source: 'center', createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } });
    if (dup) return res.json({ success: true, duplicate: true, order: dup });
  }

  if (await BlockedPhone.findOne({ phone: { $in: phoneVariants(phone) } })) {
    return res.status(403).json({ success: false, code: 'BLOCKED', message: 'هذا الرقم محظور من الطلب — راجع إدارة المطعم' });
  }
  const settings = await Setting.findOne();
  const st = (settings && settings.restaurantStatus) || {};
  if (st.mode === 'stopped') {
    return res.status(403).json({ success: false, code: 'RESTAURANT_STOPPED', message: st.message || 'المطعم متوقف عن استقبال الطلبات حالياً' });
  }

  const priced = await priceItems(b.items);
  if (priced.error) return res.status(priced.code ? 409 : 400).json({ success: false, code: priced.code, message: priced.error });

  // ── العنوان والتوصيل ──
  const addressOption = String(b.addressOption || '').trim().slice(0, 40);
  const addressDetail = String(b.addressDetail || '').trim().slice(0, 200);
  let address = [addressOption, addressDetail].filter(Boolean).join(' — ');
  let deliveryFee = 0;
  let deliveryDistance = null;
  let deliveryDistanceMode = '';
  let lat = null;
  let lng = null;
  if (orderType === 'delivery') {
    const d = (settings && settings.delivery) || {};
    if (d.enabled === false) return res.status(403).json({ success: false, code: 'DELIVERY_DISABLED', message: 'التوصيل متوقف حالياً — يمكن الاستلام من المطعم' });
    if (!address) return res.status(400).json({ success: false, message: 'اختر منطقة الزبون أو اكتب عنوانه' });
    const la = Number(b.latitude);
    const ln = Number(b.longitude);
    const hasLoc = b.latitude != null && b.longitude != null && Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 && !(la === 0 && ln === 0);
    if (hasLoc) { lat = la; lng = ln; }
    const hasRest = typeof d.restaurantLatitude === 'number' && typeof d.restaurantLongitude === 'number';
    if (hasLoc && hasRest) {
      const q = await quoteDelivery({ restaurantLat: d.restaurantLatitude, restaurantLng: d.restaurantLongitude, customerLat: la, customerLng: ln, settings: d, itemsTotal: priced.itemsTotal });
      if (!q.ok && q.reason === 'OUT_OF_RANGE') {
        return res.status(400).json({ success: false, code: 'OUT_OF_RANGE', message: `الموقع خارج نطاق التوصيل (${q.distanceKm} كم — الحد ${q.maxDistanceKm} كم)` });
      }
      if (q.ok) { deliveryFee = q.fee; deliveryDistance = q.distanceKm; deliveryDistanceMode = q.distanceMode; }
    } else if (d.pricingMode === 'byValue') {
      deliveryFee = feeForValue(priced.itemsTotal, d).fee; // حسب قيمة الطلب: لا تحتاج المسافة
    } else if (hasRest) {
      return res.status(400).json({ success: false, code: 'LOCATION_REQUIRED', message: 'حدّد موقع الزبون على الخريطة (أو أقرب معلم) لحساب رسوم التوصيل' });
    }
  } else {
    address = '';
  }

  const now = new Date();
  const confirmed = !isAgent; // موظف المطعم: مؤكَّد فوراً ويدخل جرده
  const order = await Order.create({
    orderNumber: await generateUniqueOrderNumber(),
    customerName, phone, address, addressOption: orderType === 'delivery' ? addressOption : '',
    items: priced.items,
    itemsTotal: priced.itemsTotal,
    deliveryFee,
    total: Number((priced.itemsTotal + deliveryFee).toFixed(3)),
    customerLatitude: lat, customerLongitude: lng,
    deliveryDistance, deliveryDistanceMode,
    paymentMethod: ['cash', 'cliq', 'card'].includes(b.paymentMethod) ? b.paymentMethod : 'cash',
    orderType,
    notes: String(b.notes || '').trim().slice(0, 300),
    brand: 'diyar',
    source: 'center',
    centerBy: user._id,
    centerByName: nameOf(user),
    status: confirmed ? 'new' : 'pending',
    confirmedAt: confirmed ? now : null,
    handledBy: confirmed ? user._id : null,
    handledByName: confirmed ? nameOf(user) : '',
    printRequested: true, // قسائم الأقسام تخرج تلقائياً على جهاز الطباعة في المطعم
    printed: false,
    clientRef,
    trackingToken: crypto.randomBytes(16).toString('hex'),
    timeline: [
      { event: 'status:pending', at: now, byName: nameOf(user) },
      ...(confirmed ? [{ event: 'status:new', at: now, byName: nameOf(user) }] : []),
    ],
  });

  // سجل الزبون: واحد برقمه — المنصة والسنتر معاً
  try {
    const set = {
      name: customerName, lastOrderAt: now, lastOrderType: orderType, lastSource: 'center',
      ...(orderType === 'delivery' ? {
        address, lastAddressOption: addressOption, lastAddressDetail: addressDetail,
        ...(lat != null ? { lastLatitude: lat, lastLongitude: lng } : {}),
      } : {}),
    };
    const ex = await Customer.findOne({ phone: { $in: phoneVariants(phone) } });
    if (ex) { Object.assign(ex, set); if (!ex.firstOrderAt) ex.firstOrderAt = now; await ex.save(); }
    else await Customer.create({ phone, firstOrderAt: now, ...set });
  } catch (e) { console.error('center customer upsert:', e.message); }

  logActivity({ req, order, action: 'center.order', after: order.status, details: { type: orderType, phone } });
  if (confirmed) touchOpenSession(user);
  try { realtime.emitOrderCreated(order); } catch (e) { console.error('realtime emit failed:', e.message); }
  if (!confirmed) pushService.notifyNewOrder(order).catch(() => {});
  console.log(`📞 بيع سنتر ${order.orderNumber} بواسطة ${user.username} (${order.status}) — ${order.total} د.أ`);
  res.status(201).json({ success: true, order, confirmed });
};

const brief = (o) => ({
  _id: o._id, orderNumber: o.orderNumber, createdAt: o.createdAt, source: o.source, orderType: o.orderType,
  status: o.status, total: o.total, deliveryFee: o.deliveryFee || 0, paymentMethod: o.paymentMethod || 'cash',
  address: o.address || '', addressOption: o.addressOption || '',
  customerLatitude: o.customerLatitude ?? null, customerLongitude: o.customerLongitude ?? null,
  customerName: o.customerName || '', centerByName: o.centerByName || '', driverName: o.driverName || '',
  items: (o.items || []).map((i) => ({ product: i.product ? String(i.product) : null, nameAr: i.nameAr, quantity: i.quantity, price: i.price, addons: i.addons || [], notes: i.notes || '' })),
});

// GET /api/center/customers?phone= — ملف الزبون برقمه (أو اقتراحات لرقم ناقص)
const lookupCustomer = async (req, res) => {
  const raw = String(req.query.phone || '').trim();
  const phone = normPhone(raw);
  if (!phone) {
    // اقتراحات بجزء من الرقم — لموظفي المطعم فقط (موظف السنتر لا يتصفح أرقام الزبائن)
    const digits = raw.replace(/[^\d]/g, '');
    if (req.user.role === 'center' || digits.length < 4) return res.json({ success: true, found: false, suggestions: [] });
    const rx = { $regex: digits.replace(/^0/, ''), $options: 'i' };
    const list = await Customer.find({ phone: rx }).sort({ lastOrderAt: -1 }).limit(8).select('name phone lastOrderAt').lean();
    return res.json({ success: true, found: false, suggestions: list });
  }
  const variants = phoneVariants(phone);
  const [customer, orders, blocked] = await Promise.all([
    Customer.findOne({ phone: { $in: variants } }).lean(),
    Order.find({ phone: { $in: variants } }).sort({ createdAt: -1 }).limit(400)
      .select('orderNumber createdAt source orderType status total deliveryFee paymentMethod address addressOption customerLatitude customerLongitude customerName centerByName driverName items')
      .lean(),
    BlockedPhone.findOne({ phone: { $in: variants } }).lean(),
  ]);
  const ok = orders.filter((o) => !['pending', 'cancelled'].includes(o.status));
  const lastDelivery = orders.find((o) => o.orderType === 'delivery');
  const stats = {
    count: orders.length,
    successCount: ok.length,
    cancelledCount: orders.filter((o) => o.status === 'cancelled').length,
    spent: r3(ok.reduce((t, o) => t + salesValue(o), 0)),
    web: orders.filter((o) => o.source === 'web' || o.source === 'app').length,
    center: orders.filter((o) => o.source === 'center').length,
    firstAt: orders.length ? orders[orders.length - 1].createdAt : null,
    lastAt: orders.length ? orders[0].createdAt : null,
  };
  const last = customer && (customer.lastAddressOption || customer.lastAddressDetail || customer.lastLatitude != null)
    ? {
      addressOption: customer.lastAddressOption || '', addressDetail: customer.lastAddressDetail || '',
      latitude: customer.lastLatitude ?? null, longitude: customer.lastLongitude ?? null,
    }
    : lastDelivery ? {
      addressOption: lastDelivery.addressOption || '', addressDetail: lastDelivery.addressOption ? String(lastDelivery.address || '').replace(`${lastDelivery.addressOption} — `, '') : (lastDelivery.address || ''),
      latitude: lastDelivery.customerLatitude ?? null, longitude: lastDelivery.customerLongitude ?? null,
    } : null;
  res.json({
    success: true,
    found: !!(customer || orders.length),
    phone,
    customer: customer
      ? { _id: customer._id, name: customer.name, phone: customer.phone, notes: customer.notes || '', verified: !!customer.verified, lastOrderType: customer.lastOrderType || '' }
      : orders.length ? { name: orders[0].customerName, phone } : null,
    blocked: !!blocked,
    lastAddress: last,
    stats,
    orders: orders.slice(0, 20).map(brief),
  });
};

// GET /api/center/orders?from&to&agent — طلبات السنتر (موظف السنتر: طلباته هو فقط)
const listOrders = async (req, res) => {
  const from = isYmd(req.query.from) ? req.query.from : todayYmd();
  const to = isYmd(req.query.to) ? req.query.to : from;
  const f = { source: 'center', createdAt: { $gte: dayStart(from), $lt: new Date(dayStart(to).getTime() + 86400000) } };
  const canAll = require('../middlewares/permission').hasPermission(req.user, 'center:monitor');
  if (req.user.role === 'center' || !canAll || req.query.mine === 'true') f.centerBy = req.user._id;
  else if (req.query.agent && mongoose.Types.ObjectId.isValid(req.query.agent)) f.centerBy = req.query.agent;
  const orders = await Order.find(f).sort({ createdAt: -1 }).limit(300).lean();
  const ok = orders.filter((o) => !['pending', 'cancelled'].includes(o.status));
  res.json({
    success: true,
    data: orders.map((o) => ({ ...brief(o), phone: o.phone })),
    totals: {
      count: orders.length, successCount: ok.length, value: r3(ok.reduce((t, o) => t + salesValue(o), 0)),
      pending: orders.filter((o) => o.status === 'pending').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
    },
    from, to,
  });
};

/* ═════════ مراقبة موظفي السنتر ═════════ */

const overlapMs = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/** ملخص يوم لمستخدم: ساعات الاتصال، الخلفية، الانقطاعات، والطلبات. */
const daySummary = (sessions, orders, dStart, dEnd) => {
  const now = Date.now();
  let onlineMs = 0;
  let awayMs = 0;
  let lost = 0;
  let firstSeen = null;
  let lastSeen = null;
  sessions.forEach((s) => {
    const a = new Date(s.startedAt).getTime();
    const b = s.endedAt ? new Date(s.endedAt).getTime() : now;
    onlineMs += overlapMs(a, b, dStart, dEnd);
    awayMs += Math.min(Number(s.awayMs || 0) + (s.awaySince && !s.endedAt ? now - new Date(s.awaySince).getTime() : 0), b - a);
    if (s.endReason === 'lost' && s.endedAt && new Date(s.endedAt).getTime() >= dStart && new Date(s.endedAt).getTime() < dEnd) lost += 1;
    if (!firstSeen || a < firstSeen) firstSeen = a;
    const ls = s.endedAt ? b : new Date(s.lastSeenAt).getTime();
    if (!lastSeen || ls > lastSeen) lastSeen = ls;
  });
  const ok = orders.filter((o) => !['pending', 'cancelled'].includes(o.status));
  return {
    onlineMinutes: Math.round(onlineMs / 60000),
    awayMinutes: Math.round(awayMs / 60000),
    disconnects: lost,
    sessions: sessions.length,
    firstSeen: firstSeen ? new Date(firstSeen) : null,
    lastSeen: lastSeen ? new Date(lastSeen) : null,
    orders: orders.length,
    successOrders: ok.length,
    pendingOrders: orders.filter((o) => o.status === 'pending').length,
    cancelledOrders: orders.filter((o) => o.status === 'cancelled').length,
    value: r3(ok.reduce((t, o) => t + salesValue(o), 0)),
    lastOrderAt: orders.length ? orders[0].createdAt : null,
  };
};

// GET /api/center/monitor?date= — كل موظفي السنتر (ومن أدخل طلب سنتر ذلك اليوم)
const monitor = async (req, res) => {
  const date = isYmd(req.query.date) ? req.query.date : todayYmd();
  const dStart = dayStart(date).getTime();
  const dEnd = dStart + 86400000;
  const range = { $gte: new Date(dStart), $lt: new Date(dEnd) };
  const [agents, orders, sessions] = await Promise.all([
    User.find({ role: 'center' }).select('name username isActive role phone').lean(),
    Order.find({ source: 'center', createdAt: range }).sort({ createdAt: -1 }).select('centerBy centerByName status total deliveryFee createdAt').lean(),
    PresenceSession.find({ startedAt: { $lt: new Date(dEnd) }, $or: [{ endedAt: null }, { endedAt: { $gte: new Date(dStart) } }] }).lean(),
  ]);
  const ids = new Set(agents.map((a) => String(a._id)));
  const extra = [...new Set(orders.map((o) => String(o.centerBy)).filter((id) => id && !ids.has(id)))];
  const others = extra.length ? await User.find({ _id: { $in: extra } }).select('name username isActive role').lean() : [];
  const live = new Map(presence.snapshot().map((p) => [p.userId, p]));
  const rows = agents.concat(others).map((u) => {
    const id = String(u._id);
    const p = live.get(id);
    return {
      userId: id, name: u.name || u.username, username: u.username, role: u.role, isActive: u.isActive !== false,
      live: p ? { state: p.reconnecting ? 'reconnecting' : p.state, since: p.stateSince, device: p.device, startedAt: p.startedAt } : { state: 'offline' },
      ...daySummary(sessions.filter((s) => String(s.user) === id), orders.filter((o) => String(o.centerBy) === id), dStart, dEnd),
    };
  }).sort((a, b) => (a.role === 'center' ? 0 : 1) - (b.role === 'center' ? 0 : 1) || (b.live.state !== 'offline') - (a.live.state !== 'offline') || a.name.localeCompare(b.name, 'ar'));
  res.json({ success: true, date, graceSeconds: Math.round(presence.GRACE_MS / 1000), data: rows });
};

// GET /api/center/monitor/:userId?date= — جلسات اليوم وطلباته وأحداث الاتصال
const monitorUser = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const date = isYmd(req.query.date) ? req.query.date : todayYmd();
  const dStart = dayStart(date).getTime();
  const dEnd = dStart + 86400000;
  const [user, sessions, orders, events] = await Promise.all([
    User.findById(req.params.userId).select('name username role').lean(),
    PresenceSession.find({ user: req.params.userId, startedAt: { $lt: new Date(dEnd) }, $or: [{ endedAt: null }, { endedAt: { $gte: new Date(dStart) } }] }).sort({ startedAt: 1 }).lean(),
    Order.find({ source: 'center', centerBy: req.params.userId, createdAt: { $gte: new Date(dStart), $lt: new Date(dEnd) } }).sort({ createdAt: -1 }).lean(),
    require('../models/ActivityLog').find({ user: req.params.userId, createdAt: { $gte: new Date(dStart), $lt: new Date(dEnd) }, action: { $regex: '^presence\\.' } }).sort({ createdAt: 1 }).limit(500).lean(),
  ]);
  if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });
  res.json({
    success: true, date, user,
    summary: daySummary(sessions, orders, dStart, dEnd),
    sessions: sessions.map((s) => ({ startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason || (s.endedAt ? '' : 'live'), awayMinutes: Math.round(Number(s.awayMs || 0) / 60000), device: s.device || '' })),
    events: events.map((e) => ({ at: e.createdAt, action: e.action, details: e.details || {} })),
    orders: orders.map((o) => ({ ...brief(o), phone: o.phone })),
  });
};

module.exports = wrapAll({ createOrder, lookupCustomer, listOrders, monitor, monitorUser });
module.exports.normPhone = normPhone;
