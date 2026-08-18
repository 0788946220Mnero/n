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
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

/** تهيئة الخادم — يُستدعى من server.js بعد إنشاء خادم HTTP. */
const init = (server) => {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    // ── المصادقة: JWT إلزامي ──
    const { query } = url.parse(req.url, true);
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

    const role = decoded.role || 'employee';
    const client = { socket, userId: String(decoded.id), role };
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

const emitOrderCreated = (order) => broadcast('order.created', { order: serializeOrder(order) });
const emitOrderUpdated = (order) => broadcast('order.updated', { order: serializeOrder(order) });
const emitOrderStatusChanged = (order, previousStatus) =>
  broadcast('order.status_changed', {
    order: serializeOrder(order),
    previousStatus: previousStatus || null,
  });
const emitOrderCancelled = (order) => broadcast('order.cancelled', { order: serializeOrder(order) });

const connectedCount = () => clients.size;

module.exports = {
  init,
  emitOrderCreated,
  emitOrderUpdated,
  emitOrderStatusChanged,
  emitOrderCancelled,
  connectedCount,
};
