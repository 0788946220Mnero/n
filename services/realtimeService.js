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
const presence = require('./presenceService');

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
  centerBy: order.centerBy ? String(order.centerBy) : null,
  centerByName: order.centerByName || '',
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
  mapHidden: !!order.mapHidden,
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
const upgradeRoutes = new Map(); // مسارات WebSocket أخرى على نفس الخادم (نفق الصور)
/** تسجيل مسار WebSocket إضافي (مكتبة ws ترفض كل مسار غير مسارها إن رُبطت بالخادم مباشرة). */
const onUpgrade = (path, handler) => upgradeRoutes.set(path, handler);

const init = (server) => {
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = String(req.url || '').split('?')[0];
    if (path === '/ws') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    const h = upgradeRoutes.get(path);
    if (h) return h(req, socket, head);
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  });

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
    let userName = '';
    let canMonitor = false;
    let perms = [];
    try {
      const User = require('../models/User');
      const user = await User.findById(decoded.id).select('+sessionId role isActive name username permissions').lean();
      if (!user || !user.isActive) {
        socket.close(4002, 'invalid user');
        return;
      }
      if (user.sessionId && decoded.sid !== user.sessionId) {
        socket.close(4003, 'session_replaced');
        return;
      }
      role = user.role || role;
      userName = user.name || user.username || '';
      perms = require('../utils/permissions').effectivePermissionsFor(user);
      canMonitor = perms.includes('center:monitor');
    } catch (_) {
      socket.close(1011, 'server error');
      return;
    }

    // ربما أُغلق الاتصال أثناء قراءة القاعدة
    if (socket.readyState !== 1) return;

    const client = { socket, userId: String(decoded.id), role, sid: decoded.sid || '', canMonitor, perms, name: userName };
    clients.add(client);

    socket.send(JSON.stringify({ type: 'connected', role }));

    // الحضور: جلسة اتصال للمستخدم (المراقبة) + رسائل الواجهة: away/active عند الخلفية، bye قبل الخروج
    const ua = String(req.headers['user-agent'] || '');
    const device = /iPhone|iPad/i.test(ua) ? 'آيفون' : /Android/i.test(ua) ? 'أندرويد' : /DiyarPOS|WebView2/i.test(ua) ? 'DiyarPOS' : /Windows|Macintosh|Linux/i.test(ua) ? 'كمبيوتر' : 'جهاز';
    presence.connect({ userId: client.userId, name: userName, role, socket, device });
    // لمن يراقب: الحالة الحالية لكل المتصلين فور اتصاله
    if (canMonitor) { try { socket.send(JSON.stringify({ type: 'presence.snapshot', list: presence.snapshot() })); } catch (_) {} }
    socket.on('message', (raw) => {
      // رسائل المكالمات تحمل وصف الاتصال (SDP ≈ 2–8KB) — الحد 64KB، وغيرها كما كان
      const s = String(raw);
      if (s.length > 65536) return;
      let m; try { m = JSON.parse(s); } catch (_) { return; }
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'presence') presence.setState(client.userId, m.state);
      else if (m.type === 'bye') presence.bye(client.userId);
      else if (/^(call|chat)\./.test(m.type)) { try { require('./chatService').onSocket(client, m); } catch (e) { console.error('chat ws:', e.message); } }
    });
    // دردشة الطاقم: مكالمة ترنّ له الآن (فتح التطبيق من إشعار الاتصال) + حالة «متصل» لزملائه
    try { require('./chatService').onConnect(client); } catch (e) { console.error('chat connect:', e.message); }

    const gone = () => {
      if (clients.delete(client)) {
        presence.disconnect(client.userId, socket);
        try { require('./chatService').onDisconnect(client); } catch (_) { /* */ }
      }
    };
    socket.on('close', gone);
    socket.on('error', gone);

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

  if (interval.unref) interval.unref(); // لا يُبقي العملية حيّة وحده (الخادم يبقيها)
  wss.on('close', () => clearInterval(interval));

  // المراقبة: كل تغيّر حضور يصل لمن يملك «مراقبة موظفي السنتر»
  presence.init((event) => {
    const msg = JSON.stringify(event);
    clients.forEach((c) => { if (c.canMonitor && c.socket.readyState === 1) { try { c.socket.send(msg); } catch (_) {} } });
    // دردشة الطاقم: نقطة «متصل» الخضراء — المعرّف والحالة فقط
    if (event && event.presence) {
      const p = event.presence;
      const chat = JSON.stringify({ type: 'chat.presence', userId: p.userId, online: !!p.online, state: p.state });
      clients.forEach((c) => { if (c.userId !== p.userId && (c.perms || []).includes('chat:use') && c.socket.readyState === 1) { try { c.socket.send(chat); } catch (_) {} } });
    }
  });

  console.log('🔌 خدمة الوقت الحقيقي (WebSocket) جاهزة على /ws');
};

/** بثّ حدث لأصحاب الصلاحية فقط. */
const broadcast = (type, payload) => {
  // التقرير الحي على شاشة القفل: أي تغيّر في الطلبات أو الجرد يحدّثه (بعد هدوء قصير)
  if (/^(order\.(created|status_changed|cancelled|updated)|shift\.)/.test(type)) {
    try { require('./liveReportService').touch(); } catch (_) { /* لا يعطّل البث */ }
  }
  if (!wss) return;
  const message = JSON.stringify({ type, ...payload });

  clients.forEach((c) => {
    // التحقق من الصلاحية قبل الإرسال
    if (type.startsWith('order.')) {
      // موظف السنتر: أحداث طلباته هو فقط (ليتابع حالتها) — لا بيانات زبائن غيره
      if (c.role === 'center') {
        if (!payload.order || payload.order.centerBy !== c.userId) return;
      } else if (!ORDER_VIEWER_ROLES.includes(c.role)) return;
    }
    // الرسول: أوامر المدير لأجهزة المطعم فقط (لا لموظف السنتر ولا للمندوب)
    if (type.startsWith('relay.') && !['admin', 'manager', 'cashier'].includes(c.role)) return;
    // تنبيهات سحابة الصور (ملفات ناقصة/جهاز منقطع): لمدير النظام فقط
    if (type.startsWith('imagecloud.') && c.role !== 'admin') return;
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
/** رسالة زبون جديدة أو ردّ عليها: اللوحة تُنبَّه (صوت + شارة)، والزبون يرى الحالة. */
const serializeRequest = (r) => ({
  _id: String(r._id), kind: r.kind, text: r.text || '', amount: Number(r.amount || 0), status: r.status,
  items: (r.items || []).map((i) => ({ nameAr: i.nameAr, quantity: i.quantity, price: i.price, addons: i.addons || [], notes: i.notes || '' })),
  reply: r.reply || '', createdAt: r.createdAt, resolvedAt: r.resolvedAt || null, resolvedByName: r.resolvedByName || '',
});
const emitOrderRequest = (order, request) => {
  broadcast('order.request', { order: serializeOrder(order), request: serializeRequest(request) });
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
    presence.disconnect(c.userId, c.socket);
  });
};

/** خروج طبيعي من الحساب: لا يُعدّ انقطاعاً في المراقبة. */
const markLogout = (userId) => presence.bye(userId);

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

/* ── دردشة الطاقم: إرسال لمستخدمين بأعينهم ── */
const send = (c, payload) => {
  if (!c || c.socket.readyState !== 1) return false;
  try { c.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); return true; } catch (_) { return false; }
};
/** كل اتصالات مستخدم. */
const clientsOf = (userId) => [...clients].filter((c) => c.userId === String(userId));
/** يرسل لكل اتصالات مجموعة مستخدمين (أو filter على الاتصال). يرجع المستخدمين الذين وصلتهم. */
const sendToUsers = (userIds, payload, filter) => {
  const ids = userIds ? new Set([...userIds].map(String)) : null;
  const msg = JSON.stringify(payload);
  const got = new Set();
  clients.forEach((c) => {
    if (ids && !ids.has(c.userId)) return;
    if (filter && !filter(c)) return;
    if (send(c, msg)) got.add(c.userId);
  });
  return got;
};
/** هل التطبيق ظاهر أمام المستخدم الآن (متصل وغير مقفل/في الخلفية)؟ — لا إشعار دفع حينها. */
const isVisible = (userId) => {
  const st = presence.stateOf ? presence.stateOf(String(userId)) : null;
  return !!(st && st.online && st.state === 'active');
};
const isOnline = (userId) => clientsOf(userId).some((c) => c.socket.readyState === 1);

/** أُغلق جرد: الخرائط واللوحات المفتوحة تعيد جلب ما تغيّر (طلبات صارت من جرد سابق). */
const emitShiftClosed = (shiftId, scope) => broadcast('shift.closed', { shiftId, scope });

module.exports = {
  init,
  onUpgrade,
  broadcast,
  emitShiftClosed,
  emitOrderCreated,
  emitOrderUpdated,
  emitOrderStatusChanged,
  emitOrderCancelled,
  emitOrderRequest,
  endOtherSessions,
  markLogout,
  emitPrintJob,
  emitPrintJobUpdated,
  connectedCount,
  send,
  clientsOf,
  sendToUsers,
  isVisible,
  isOnline,
};
