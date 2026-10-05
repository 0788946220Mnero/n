/**
 * خدمة الوقت الحقيقي (WebSocket) لتطبيق الإدارة.
 *
 * - المصادقة إلزامية: JWT يُرسَل في رابط الاتصال (?token=...)
 * - التحقق من الدور: من لا يملك صلاحية مشاهدة الطلبات لا يستقبل أحداثها
 * - الأحداث: order.created | order.updated | order.status_changed | order.cancelled
 * - لا يُرسَل في الحدث إلا الحقول الضرورية (لا بيانات حساسة)
 */

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');
const { publicOrder, tokenMatches } = require('../utils/publicOrder');
const { deliveryState } = require('../utils/deliveryState');

let wss = null;
const clients = new Set(); // { socket, userId, role }

// الأدوار التي يحقّ لها استقبال أحداث الطلبات
const ORDER_VIEWER_ROLES = ['admin', 'manager', 'cashier', 'employee'];

/** حمولة الحدث: الحقول الضرورية فقط. */
const serializeOrder = (order) => ({
  _id: String(order._id),
  orderNumber: order.orderNumber,
  customerName: order.customerName,
  phone: order.phone,
  status: order.status,
  orderType: order.orderType,
  total: order.total,
  itemsTotal: order.itemsTotal,
  deliveryFee: order.deliveryFee,
  deliveryDistance: order.deliveryDistance ?? null,
  customerLatitude: order.customerLatitude ?? null,
  customerLongitude: order.customerLongitude ?? null,
  locationUrl:
    order.customerLatitude != null && order.customerLongitude != null
      ? `https://www.google.com/maps?q=${order.customerLatitude},${order.customerLongitude}`
      : null,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  // التوصيل والخريطة: كل ما يلزم لتحديث العلامة واللوحة دون إعادة جلب
  source: order.source,
  address: order.address || '',
  paymentMethod: order.paymentMethod || 'cash',
  driver: order.driver ? String(order.driver) : null,
  driverName: order.driverName || '',
  driverAssignedAt: order.driverAssignedAt || null,
  deliverySentAt: order.deliverySentAt || null,
  outForDeliveryAt: order.outForDeliveryAt || null,
  deliveredAt: order.deliveredAt || null,
  cancelledAt: order.cancelledAt || null,
  confirmedAt: order.confirmedAt || null,
  closed: !!order.closed,
  deliveryState: order.orderType === 'delivery' && order.source !== 'pos' ? deliveryState(order) : '',
});

/* ── اشتراكات الزبائن: كل زبون يستقبل تحديثات طلباته فقط (برمز التتبع) ── */
const trackers = new Set(); // { socket, orderIds: Set<string> }

const emitTracking = (order) => {
  if (!order || !trackers.size) return;
  const id = String(order._id);
  let message = null;
  trackers.forEach((t) => {
    if (!t.orderIds.has(id) || t.socket.readyState !== 1) return;
    if (!message) message = JSON.stringify({ type: 'order.track', order: publicOrder(order) });
    try { t.socket.send(message); } catch (_) {}
  });
};

/** اتصال زبون: ?track=<id>:<token>,<id>:<token> — يُتحقق من كل رمز في القاعدة. */
const acceptTracker = async (socket, trackParam) => {
  const pairs = String(trackParam || '')
    .split(',')
    .slice(0, 20)
    .map((p) => p.split(':'))
    .filter(([id, token]) => id && token && /^[a-f0-9]{24}$/i.test(id));
  if (!pairs.length) { socket.close(4001, 'track required'); return; }

  let orders = [];
  try {
    const Order = require('../models/Order');
    orders = await Order.find({ _id: { $in: pairs.map(([id]) => id) } }).select('+trackingToken').lean();
  } catch (_) {
    socket.close(1011, 'server error');
    return;
  }
  const tokens = new Map(pairs);
  const allowed = orders.filter((o) => tokenMatches(o.trackingToken, tokens.get(String(o._id))));
  if (!allowed.length) { socket.close(4002, 'invalid track'); return; }
  if (socket.readyState !== 1) return;

  const tracker = { socket, orderIds: new Set(allowed.map((o) => String(o._id))) };
  trackers.add(tracker);
  // الحالة الحالية فور الاتصال (وبعد كل إعادة اتصال): لا يفوت الزبون تغييراً حدث أثناء الانقطاع
  socket.send(JSON.stringify({ type: 'track.ready', orders: allowed.map(publicOrder) }));
  socket.on('close', () => trackers.delete(tracker));
  socket.on('error', () => trackers.delete(tracker));
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
};

/** تهيئة الخادم — يُستدعى من server.js بعد إنشاء خادم HTTP. */
const init = (server) => {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket, req) => {
    // ── المصادقة: JWT إلزامي ──
    const { query } = url.parse(req.url, true);

    // زبون يتابع طلباته (بلا JWT — برمز تتبع كل طلب)
    if (query.track && !query.token) {
      acceptTracker(socket, query.track);
      return;
    }

    const token = query.token;

    if (!token) {
      socket.close(4001, 'مطلوب رمز الدخول');
      return;
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      socket.close(4002, 'رمز غير صالح');
      return;
    }

    /* الرمز يحمل المعرّف فقط، فالدور والجلسة يُقرآن من القاعدة.
       رمز جلسة مستبدَلة يُرفض برمز 4003 لتعرف الواجهة السبب. */
    let role = decoded.role || 'employee';
    try {
      const User = require('../models/User');
      const user = await User.findById(decoded.id).select('+sessionId role isActive').lean();
      if (!user || !user.isActive) {
        socket.close(4002, 'invalid user');
        return;
      }
      if (user.sessionId && decoded.sid !== user.sessionId) {
        socket.close(4003, 'session_replaced');
        return;
      }
      role = user.role || role;
    } catch (_) {
      socket.close(1011, 'server error');
      return;
    }

    // ربما أُغلق الاتصال أثناء قراءة القاعدة
    if (socket.readyState !== 1) return;

    const client = { socket, userId: String(decoded.id), role, sid: decoded.sid || '' };
    clients.add(client);

    socket.send(JSON.stringify({ type: 'connected', role }));

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));

    // نبضة إبقاء الاتصال حياً
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
  });

  // فحص دوري للاتصالات الميتة
  const interval = setInterval(() => {
    wss.clients.forEach((s) => {
      if (s.isAlive === false) return s.terminate();
      s.isAlive = false;
      try { s.ping(); } catch (_) {}
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  console.log('🔌 خدمة الوقت الحقيقي (WebSocket) جاهزة على /ws');
};

/** بثّ حدث لأصحاب الصلاحية فقط. */
const broadcast = (type, payload) => {
  if (!wss) return;
  const message = JSON.stringify({ type, ...payload });

  clients.forEach((c) => {
    // التحقق من الصلاحية قبل الإرسال
    if (type.startsWith('order.') && !ORDER_VIEWER_ROLES.includes(c.role)) return;
    if (c.socket.readyState === 1) {
      try { c.socket.send(message); } catch (_) {}
    }
  });
};

const emitOrderCreated = (order) => { broadcast('order.created', { order: serializeOrder(order) }); emitTracking(order); };
const emitOrderUpdated = (order) => { broadcast('order.updated', { order: serializeOrder(order) }); emitTracking(order); };
const emitOrderStatusChanged = (order, previousStatus) => {
  broadcast('order.status_changed', {
    order: serializeOrder(order),
    previousStatus: previousStatus || null,
  });
  emitTracking(order);
};
const emitOrderCancelled = (order) => { broadcast('order.cancelled', { order: serializeOrder(order) }); emitTracking(order); };

/**
 * جلسة واحدة لكل مستخدم: عند دخول جديد تُبلَّغ اتصالات الجلسات الأخرى
 * لنفس المستخدم ثم تُغلق، فيخرج الجهاز القديم فوراً لا عند طلبه التالي.
 */
const endOtherSessions = (userId, keepSid) => {
  const id = String(userId);
  clients.forEach((c) => {
    if (c.userId !== id || c.sid === keepSid) return;
    try { c.socket.send(JSON.stringify({ type: 'session.replaced' })); } catch (_) {}
    try { c.socket.close(4003, 'session_replaced'); } catch (_) {}
    clients.delete(c);
  });
};

/* مهام الطباعة عن بُعد: تُبث لكل اتصالات الموظفين؛ جهاز الكاشير
   يحجز المهمة ذرّياً عبر الـ API، والمرسِل يتابع حالتها بمعرّفها. */
const serializePrintJob = (job) => ({
  _id: String(job._id),
  type: job.type,
  status: job.status,
  order: job.order && job.order._id ? String(job.order._id) : (job.order ? String(job.order) : null),
  requestedBy: job.requestedBy ? String(job.requestedBy) : null,
  requestedByName: job.requestedByName || '',
  claimedBy: job.claimedBy || '',
  error: job.error || '',
});

const emitPrintJob = (job) => broadcast('print.job', { job: serializePrintJob(job) });
const emitPrintJobUpdated = (job) => broadcast('print.job.updated', { job: serializePrintJob(job) });

const connectedCount = () => clients.size;

module.exports = {
  init,
  emitOrderCreated,
  emitOrderUpdated,
  emitOrderStatusChanged,
  emitOrderCancelled,
  endOtherSessions,
  emitPrintJob,
  emitPrintJobUpdated,
  connectedCount,
};
