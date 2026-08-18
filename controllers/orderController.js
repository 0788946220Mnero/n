const mongoose = require('mongoose');
const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const BlockedPhone = require('../models/BlockedPhone');
const Setting = require('../models/Setting');
const { quoteDelivery } = require('../services/deliveryFeeService');
const realtime = require('../services/realtimeService');
const pushService = require('../services/pushService');

// GET /api/orders?status=new&page=1&limit=10
const getOrders = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = {};
  // افتراضياً نعرض الطلبات المفتوحة فقط (غير المؤرشفة بإغلاق جرد سابق)
  if (req.query.includeClosed !== 'true') filter.closed = { $ne: true };
  if (req.query.shiftId) filter.shiftId = req.query.shiftId;
  if (req.query.brand) filter.brand = req.query.brand;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) {
    filter.$or = [
      { orderNumber: { $regex: req.query.search, $options: 'i' } },
      { customerName: { $regex: req.query.search, $options: 'i' } },
      { phone: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter).sort('-createdAt').skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);

  // إرفاق حالة توثيق رقم كل طلب (استعلام واحد للأرقام الموثّقة)
  const phones = [...new Set(orders.map((o) => o.phone).filter(Boolean))];
  const verifiedPhones = new Set(
    (await Customer.find({ phone: { $in: phones }, verified: true }).select('phone').lean()).map((c) => c.phone)
  );
  orders.forEach((o) => { o.phoneVerified = verifiedPhones.has(o.phone); });

  res.json({ data: orders, pagination: { total, page, pages: Math.ceil(total / limit), limit } });
};

// GET /api/orders/:id
const getOrder = async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  res.json(order);
};

// POST /api/orders
// يُنشئ الطلب بحالة "معلّق" (pending) فقط — لا يدخل السجل التشغيلي ولا يؤثر على
// إحصائيات العملاء أو جرد المنتجات إلا بعد أن يُؤكَّد يدوياً من لوحة التحكم (confirmOrder).
const createOrder = async (req, res) => {
  try {
    const { customerName, phone, address, items, total, itemsTotal, deliveryFee, paymentMethod, orderType, notes, printRequested, brand, customerLatitude, customerLongitude } = req.body;

    if (!customerName || !phone || !items || !items.length || !total) {
      return res.status(400).json({ success: false, message: 'بيانات الطلب غير مكتملة' });
    }

    // التحقق من صيغة رقم الهاتف الأردني (10 أرقام تبدأ بـ 07) — يمنع تجاوز الواجهة عبر API مباشرة
    const normalizedPhone = String(phone).replace(/[\s-]/g, '');
    if (!/^07\d{8}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PHONE',
        message: 'يرجى إدخال رقم هاتف صحيح مكوّن من 10 أرقام ويبدأ بـ 07.',
      });
    }

    const blocked = await BlockedPhone.findOne({ phone });
    if (blocked) {
      return res.status(403).json({ success: false, message: 'عذراً، لا يمكن إتمام الطلب من هذا الرقم. يرجى التواصل مع المطعم.' });
    }

    // فحص حالة المطعم (مشغول/متوقف) — مع رجوع تلقائي عند انتهاء وقت الانشغال
    const settings = await Setting.findOne();
    if (settings && settings.restaurantStatus) {
      let { mode, busyUntil, message } = settings.restaurantStatus;
      if (mode === 'busy' && busyUntil && Date.now() > new Date(busyUntil).getTime()) {
        mode = 'open';
        settings.restaurantStatus.mode = 'open';
        settings.restaurantStatus.busyUntil = null;
        await settings.save();
      }
      if (mode === 'stopped') {
        return res.status(403).json({ success: false, code: 'RESTAURANT_STOPPED', message: message || 'المطعم متوقف عن استقبال الطلبات حالياً.' });
      }
      if (mode === 'busy') {
        return res.status(403).json({ success: false, code: 'RESTAURANT_BUSY', message: message || 'المطعم مشغول حالياً بسبب كثرة الطلبات، الرجاء المحاولة بعد قليل.' });
      }
    }

    // فحص توفّر المنتجات (منع طلب صنف موقوف مؤقتاً حتى لو تجاوز الواجهة)
    const productIds = items.map((it) => it.product).filter((id) => id && mongoose.Types.ObjectId.isValid(id));
    if (productIds.length) {
      const unavailable = await Product.find({ _id: { $in: productIds }, isAvailable: false }).select('nameAr');
      if (unavailable.length) {
        const names = unavailable.map((p) => p.nameAr).join('، ');
        return res.status(409).json({ success: false, code: 'ITEM_UNAVAILABLE', message: `عذراً، أصبح غير متوفر حالياً: ${names}. الرجاء تعديل طلبك.` });
      }
    }

    const orderNumber = `ORD-${Date.now().toString().slice(-8)}`;

    // توحيد شكل الأصناف القادمة من الواجهة مع النموذج، مع تجاهل product غير الصالح
    const normalizedItems = items.map((item) => {
      const normalized = {
        nameAr: item.nameAr || item.name || '',
        quantity: Number(item.quantity || item.qty || 1),
        price: Number(item.price || 0),
        addons: Array.isArray(item.addons) ? item.addons : [],
      };
      // نُدرج product فقط إن كان ObjectId صالحاً (أصناف حقيقية من قاعدة البيانات)
      if (item.product && mongoose.Types.ObjectId.isValid(item.product)) {
        normalized.product = item.product;
      }
      return normalized;
    });

    // ═══ حساب رسوم التوصيل في الخادم (مصدر الحقيقة) ═══
    // نتجاهل أي deliveryFee قادم من الواجهة ونعيد حسابه من الإحداثيات وإعدادات المطعم.
    const isDelivery = (orderType || 'delivery') !== 'pickup';
    const computedItemsTotal = Number(
      itemsTotal != null ? itemsTotal : normalizedItems.reduce((t, i) => t + i.price * i.quantity, 0)
    );

    let serverDeliveryFee = 0;
    let deliveryDistance = null;
    let deliveryDistanceMode = '';
    let custLat = null;
    let custLng = null;

    if (isDelivery) {
      const dcfg = (settings && settings.delivery) || {};

      // التوصيل متوقف من لوحة التحكم
      if (dcfg.enabled === false) {
        return res.status(403).json({
          success: false,
          code: 'DELIVERY_DISABLED',
          message: 'خدمة التوصيل متوقفة حالياً. يمكنك اختيار الاستلام من المطعم.',
        });
      }

      const hasRestaurantLoc =
        typeof dcfg.restaurantLatitude === 'number' && typeof dcfg.restaurantLongitude === 'number';
      const lat = Number(customerLatitude);
      const lng = Number(customerLongitude);
      const hasCustomerLoc = Number.isFinite(lat) && Number.isFinite(lng);

      // نحسب الرسوم فقط عند توفّر الموقعين؛ وإلا نُبقي الرسوم صفراً
      // (توافقاً مع الطلبات التي تُرسَل بلا إحداثيات).
      if (hasRestaurantLoc && hasCustomerLoc) {
        const quote = await quoteDelivery({
          restaurantLat: dcfg.restaurantLatitude,
          restaurantLng: dcfg.restaurantLongitude,
          customerLat: lat,
          customerLng: lng,
          settings: dcfg,
        });

        if (!quote.ok && quote.reason === 'OUT_OF_RANGE') {
          return res.status(400).json({
            success: false,
            code: 'OUT_OF_RANGE',
            message: `الموقع خارج نطاق التوصيل (الحد الأقصى ${quote.maxDistanceKm} كم). يمكنك تعديل الموقع أو اختيار الاستلام من المطعم.`,
            distanceKm: quote.distanceKm,
          });
        }
        if (!quote.ok && quote.reason === 'INVALID_COORDINATES') {
          return res.status(400).json({
            success: false,
            code: 'INVALID_COORDINATES',
            message: 'الموقع المُرسَل غير صالح. الرجاء تحديد الموقع من جديد.',
          });
        }

        if (quote.ok) {
          serverDeliveryFee = quote.fee;
          deliveryDistance = quote.distanceKm;
          deliveryDistanceMode = quote.distanceMode;
          custLat = lat;
          custLng = lng;
        }
      }
    }

    const serverTotal = Number((computedItemsTotal + serverDeliveryFee).toFixed(2));

    const order = await Order.create({
      orderNumber,
      customerName,
      phone,
      address,
      items: normalizedItems,
      itemsTotal: computedItemsTotal,
      deliveryFee: serverDeliveryFee,
      total: serverTotal,
      customerLatitude: custLat,
      customerLongitude: custLng,
      deliveryDistance,
      deliveryDistanceMode,
      paymentMethod,
      orderType: orderType || 'delivery',
      brand: brand || 'diyar',
      notes: notes || '',
      status: 'pending',
      printRequested: printRequested === true,
      printed: false,
    });

    // سجل العميل: إنشاء إن لم يوجد، وتحديث بياناته إن وُجد (بلا تكرار)
    try {
      const existing = await Customer.findOne({ phone });
      if (existing) {
        existing.name = customerName || existing.name;
        if (address) existing.address = address;
        existing.lastOrderAt = new Date();
        if (!existing.firstOrderAt) existing.firstOrderAt = new Date();
        await existing.save();
      } else {
        await Customer.create({
          name: customerName,
          phone,
          address: address || '',
          firstOrderAt: new Date(),
          lastOrderAt: new Date(),
        });
      }
    } catch (e) { /* لا نُفشل الطلب إن تعذّر تحديث سجل العميل */ }

    // بثّ فوري لتطبيق الإدارة + إشعار FCM (لا يعطّلان إنشاء الطلب إن فشلا)
    try { realtime.emitOrderCreated(order); } catch (e) { console.error('realtime emit failed:', e.message); }
    pushService.notifyNewOrder(order).catch((e) => console.error('push failed:', e.message));

    res.status(201).json({ success: true, order, orderNumber });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إنشاء الطلب', error: err.message });
  }
};

// PUT /api/orders/:id/confirm
// يُستخدم من لوحة التحكم فقط لتأكيد طلب معلّق. هنا فقط يتم:
// 1) تحويل حالة الطلب من pending إلى new (يدخل السجل التشغيلي رسمياً)
// 2) تحديث/إنشاء بيانات العميل (عدد الطلبات، إجمالي الإنفاق)
// 3) خصم الكمية من جرد المنتجات (إن كانت مُفعّلة لمنتج معيّن) وزيادة عدّاد الطلبات لكل منتج
const confirmOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'هذا الطلب مؤكَّد مسبقاً أو ليس بحالة معلّقة' });
    }

    // 1) تحديث حالة الطلب
    order.status = 'new';
    order.confirmedAt = new Date();
    await order.save();

    // 2) تحديث بيانات العميل — الآن فقط، عند التأكيد
    let customer = await Customer.findOne({ phone: order.phone });
    if (customer) {
      customer.ordersCount += 1;
      customer.totalSpent += order.total;
      customer.lastOrderAt = new Date();
      await customer.save();
    } else {
      customer = await Customer.create({
        name: order.customerName,
        phone: order.phone,
        address: order.address,
        ordersCount: 1,
        totalSpent: order.total,
        lastOrderAt: new Date(),
      });
    }

    // 3) دخول الجرد — خصم الكمية المؤكَّدة من مخزون كل منتج (إن كان مُفعّلاً)، وزيادة عدّاد الطلبات
    for (const item of order.items) {
      if (!item.product) continue;
      const product = await Product.findById(item.product);
      if (!product) continue;

      product.ordersCount = (product.ordersCount || 0) + item.quantity;
      if (product.stock !== null && product.stock !== undefined) {
        product.stock = Math.max(0, product.stock - item.quantity);
      }
      await product.save();
    }

    // بثّ تأكيد الطلب لتطبيق الإدارة
    try { realtime.emitOrderStatusChanged(order, 'pending'); } catch (e) { console.error('realtime emit failed:', e.message); }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر تأكيد الطلب', error: err.message });
  }
};

// PUT /api/orders/:id/status
const updateOrderStatus = async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: 'حالة الطلب غير صحيحة' });
  }

  // نقرأ الحالة السابقة لإرسالها ضمن الحدث
  const previous = await Order.findById(req.params.id).select('status');
  const previousStatus = previous ? previous.status : null;

  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });

  // بثّ فوري لتطبيق الإدارة
  try {
    if (status === 'cancelled') realtime.emitOrderCancelled(order);
    else realtime.emitOrderStatusChanged(order, previousStatus);
  } catch (e) {
    console.error('realtime emit failed:', e.message);
  }

  res.json(order);
};

// GET /api/orders/stats/dashboard
const getDashboardStats = async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // نستثني الطلبات المعلّقة (pending) والملغية من إحصائيات المبيعات والأصناف الأكثر طلباً
  // لأنها لم تُؤكَّد بعد ولم تدخل الجرد فعلياً
  const confirmedFilter = { status: { $nin: ['pending', 'cancelled'] } };

  const [todayOrders, pendingOrders, todaySalesAgg, monthlySalesAgg, latestOrders, topProducts, deliveryAgg] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: startOfDay }, ...confirmedFilter }),
    Order.countDocuments({ status: 'pending' }),
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfDay }, ...confirmedFilter } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfMonth }, ...confirmedFilter } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    Order.find().sort('-createdAt').limit(5),
    Order.aggregate([
      { $match: confirmedFilter },
      { $unwind: '$items' },
      { $group: { _id: '$items.nameAr', totalOrdered: { $sum: '$items.quantity' } } },
      { $sort: { totalOrdered: -1 } },
      { $limit: 5 },
    ]),
    // إحصائيات التوصيل والاستلام لليوم (بيانات حقيقية من الطلبات)
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfDay }, ...confirmedFilter } },
      {
        $group: {
          _id: '$orderType',
          count: { $sum: 1 },
          feesTotal: { $sum: { $ifNull: ['$deliveryFee', 0] } },
          avgDistance: { $avg: '$deliveryDistance' },
          withLocation: {
            $sum: { $cond: [{ $ifNull: ['$customerLatitude', false] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  // تفكيك نتيجة التجميع إلى شكل واضح للتطبيق
  const deliveryRow = deliveryAgg.find((r) => r._id === 'delivery');
  const pickupRow = deliveryAgg.find((r) => r._id === 'pickup');

  const round2 = (v) => Number((Number(v) || 0).toFixed(2));

  res.json({
    todayOrders,
    pendingOrders,
    todaySales: todaySalesAgg[0]?.total || 0,
    monthlySales: monthlySalesAgg[0]?.total || 0,
    latestOrders,
    topProducts,
    // ═══ إحصائيات التوصيل (جديدة — لا تكسر أي حقل قائم) ═══
    deliveryToday: {
      count: deliveryRow?.count || 0,
      feesTotal: round2(deliveryRow?.feesTotal),
      avgDistanceKm: deliveryRow?.avgDistance != null ? round2(deliveryRow.avgDistance) : null,
      withLocation: deliveryRow?.withLocation || 0,
    },
    pickupToday: {
      count: pickupRow?.count || 0,
    },
  });
};


// ─── طابور الطباعة (برنامج الطابعة المحلي) ───
const getPrintQueue = async (req, res) => {
  try {
    const printFilter = { printRequested: true, printed: false };
    if (req.query.brand) printFilter.brand = req.query.brand;
    const orders = await Order.find(printFilter).sort('createdAt').limit(20);
    res.json({ success: true, count: orders.length, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر جلب طابور الطباعة', error: err.message });
  }
};

const markPrinted = async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { printed: true, printedAt: new Date() }, { new: true });
    if (!order) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر تحديث حالة الطباعة', error: err.message });
  }
};

// ─── حظر أرقام الزبائن ───
const getBlockedPhones = async (req, res) => {
  try {
    const list = await BlockedPhone.find().sort('-createdAt');
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر جلب قائمة الحظر', error: err.message });
  }
};

const blockPhone = async (req, res) => {
  try {
    const { phone, name, reason } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'رقم الهاتف مطلوب' });
    const blocked = await BlockedPhone.findOneAndUpdate(
      { phone },
      { phone, name: name || '', reason: reason || '' },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, blocked });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حظر الرقم', error: err.message });
  }
};

const unblockPhone = async (req, res) => {
  try {
    await BlockedPhone.findOneAndDelete({ phone: req.params.phone });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر رفع الحظر', error: err.message });
  }
};


// ─────────── إغلاق الجرد (Z-Report) ───────────
// المبدأ: لا تُحذف أي طلبات إطلاقاً — تُؤرشف (closed=true) فتختفي من القائمة الحالية
// ويبقى السجل المالي كاملاً في قاعدة البيانات للرجوع إليه.

const buildShiftSummary = async (filter) => {
  const orders = await Order.find(filter).lean();

  const successStatuses = ['delivered'];
  const pendingStatuses = ['pending', 'new', 'preparing', 'ready', 'out_for_delivery'];

  const sum = (arr) => arr.reduce((t, o) => t + Number(o.total || 0), 0);

  const success = orders.filter((o) => successStatuses.includes(o.status));
  const pendingList = orders.filter((o) => pendingStatuses.includes(o.status));
  const cancelled = orders.filter((o) => o.status === 'cancelled');

  return {
    totalOrders: orders.length,
    successCount: success.length,
    successTotal: Number(sum(success).toFixed(2)),
    pendingCount: pendingList.length,
    pendingTotal: Number(sum(pendingList).toFixed(2)),
    cancelledCount: cancelled.length,
    cancelledTotal: Number(sum(cancelled).toFixed(2)),
    generatedAt: new Date(),
  };
};

// GET /api/orders/shift-summary — معاينة الجرد قبل الإغلاق (لا تُغيّر شيئاً)
const getShiftSummary = async (req, res) => {
  try {
    const filter = { closed: { $ne: true } };
    if (req.query.brand) filter.brand = req.query.brand;
    const summary = await buildShiftSummary(filter);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ message: 'تعذر حساب ملخص الجرد', error: err.message });
  }
};

// POST /api/orders/close-shift  { password }
// يتطلب كلمة مرور الأدمن، ثم يؤرشف الطلبات المفتوحة ويعيد ملخص الجرد للطباعة
const closeShift = async (req, res) => {
  try {
    const { password, brand } = req.body;
    if (!password) return res.status(400).json({ message: 'كلمة المرور مطلوبة لإغلاق الجرد' });

    // التحقق من كلمة مرور المستخدم الحالي
    const User = require('../models/User');
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: 'كلمة المرور غير صحيحة' });

    const filter = { closed: { $ne: true } };
    if (brand) filter.brand = brand;

    const summary = await buildShiftSummary(filter);
    if (summary.totalOrders === 0) {
      return res.status(400).json({ message: 'لا توجد طلبات لإغلاقها حالياً' });
    }

    const shiftId = 'SHIFT-' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    await Order.updateMany(filter, { $set: { closed: true, closedAt: new Date(), shiftId } });

    console.log(`📊 إغلاق جرد ${shiftId} بواسطة ${user.username} — ناجحة: ${summary.successCount} (${summary.successTotal}) | معلّقة: ${summary.pendingCount} | ملغاة: ${summary.cancelledCount}`);

    res.json({ success: true, shiftId, summary, message: 'تم إغلاق الجرد وتصفير قائمة الطلبات' });
  } catch (err) {
    res.status(500).json({ message: 'تعذر إغلاق الجرد', error: err.message });
  }
};

module.exports = {
  getShiftSummary,
  closeShift, getOrders, getOrder, createOrder, confirmOrder, updateOrderStatus, getDashboardStats, getPrintQueue, markPrinted, getBlockedPhones, blockPhone, unblockPhone };
