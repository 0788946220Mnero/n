const { wrapAll } = require('../utils/asyncHandler');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Expense = require('../models/Expense');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const BlockedPhone = require('../models/BlockedPhone');
const Setting = require('../models/Setting');
const { quoteDelivery } = require('../services/deliveryFeeService');
const realtime = require('../services/realtimeService');
const pushService = require('../services/pushService');
const { generateUniqueOrderNumber } = require('../utils/orderNumber');
const printerService = require('../services/printerService');
const { extractCoordinates } = require('../utils/coords');

// رابط خرائط جاهز من الإحداثيات الفعلية — يظهر في لوحة التحكم كحقل locationUrl
/** اسم المستخدم الظاهر في الجرد والتقارير. */
const handlerName = (u) => (u && (u.name || u.username)) || '';

/**
 * ينسب الطلب لأول من تعامل معه، مرة واحدة فقط: الشرط handledBy:null
 * داخل الاستعلام نفسه يمنع مستخدمَين من الاستيلاء عليه في نفس اللحظة.
 */
const claimHandler = async (order, user) => {
  if (!order || order.handledBy || !user) return;
  const res = await Order.updateOne(
    { _id: order._id, handledBy: null },
    { $set: { handledBy: user._id, handledByName: handlerName(user) } }
  );
  if (res.modifiedCount) {
    order.handledBy = user._id;
    order.handledByName = handlerName(user);
  }
};

const mapLink = (lat, lng) =>
  Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : null;

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
  orders.forEach((o) => {
    o.phoneVerified = verifiedPhones.has(o.phone);
    o.locationUrl = mapLink(o.customerLatitude, o.customerLongitude);
  });

  res.json({ data: orders, pagination: { total, page, pages: Math.ceil(total / limit), limit } });
};

// GET /api/orders/:id
const getOrder = async (req, res) => {
  const order = await Order.findById(req.params.id).lean();
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  order.locationUrl = mapLink(order.customerLatitude, order.customerLongitude);
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

    // ✅ نفحص الرقم كما أُرسل وبعد التطبيع معاً، حتى لا يفلت الحظر بسبب فراغ أو شرطة
    const blocked = await BlockedPhone.findOne({ phone: { $in: [phone, normalizedPhone] } });
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

    // ✅ رقم تسلسلي حقيقي (عدّاد ذرّي) بدل الرقم المشتق من الوقت
    const orderNumber = await generateUniqueOrderNumber();

    // توحيد شكل الأصناف القادمة من الواجهة مع النموذج، مع تجاهل product غير الصالح
    const normalizedItems = items.map((item) => {
      const normalized = {
        nameAr: item.nameAr || item.name || '',
        quantity: Number(item.quantity || item.qty || 1),
        price: Number(item.price || 0),
        addons: Array.isArray(item.addons) ? item.addons : [],
        notes: item.notes || '',
      };
      // نُدرج product فقط إن كان ObjectId صالحاً (أصناف حقيقية من قاعدة البيانات)
      if (item.product && mongoose.Types.ObjectId.isValid(item.product)) {
        normalized.product = item.product;
      }
      return normalized;
    });

    // نسخ طابعة كل صنف من المنتج (تبقى ثابتة مع الطلب حتى لو تغيّرت لاحقاً)
    try {
      const ids = normalizedItems.map((i) => i.product).filter(Boolean);
      if (ids.length) {
        const products = await Product.find({ _id: { $in: ids } }).select('printerName').lean();
        const printerMap = new Map(products.map((p) => [String(p._id), p.printerName || '']));
        normalizedItems.forEach((i) => {
          if (i.product) i.printerName = printerMap.get(String(i.product)) || '';
        });
      }
    } catch (e) {
      console.error('تعذّر جلب طابعات الأصناف:', e.message);
    }

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

      // ✅ نقبل كل صيغ الإحداثيات التي قد ترسلها الواجهة، لا الاسمين المتوقّعين فقط
      const found = extractCoordinates(req.body);
      const hasCustomerLoc = !!found;
      const lat = found ? found.lat : NaN;
      const lng = found ? found.lng : NaN;

      // ✅ الإحداثيات تُحفَظ دائماً ما دامت صالحة — سابقاً كانت تُحفَظ فقط
      // إذا نجح حساب رسوم التوصيل، فإن لم يكن موقع المطعم مضبوطاً ضاع موقع الزبون.
      if (hasCustomerLoc) {
        custLat = lat;
        custLng = lng;
        console.log(`📍 موقع الزبون محفوظ (${lat}, ${lng}) — مصدر الحقل: ${found.source}`);
      } else {
        // سجل تشخيصي: يكشف ماذا أرسلت الواجهة فعلاً بدل التخمين
        console.warn('──────────────────────────────────────────────');
        console.warn(`📍 طلب توصيل بلا إحداثيات — ${customerName || ''} / ${phone || ''}`);
        console.warn(`   الحقول التي وصلت من الواجهة: ${Object.keys(req.body || {}).join(', ')}`);
        console.warn(`   customerLatitude=${JSON.stringify(customerLatitude)} customerLongitude=${JSON.stringify(customerLongitude)}`);
        console.warn('──────────────────────────────────────────────');
      }
      if (!hasRestaurantLoc) {
        console.warn('📍 موقع المطعم غير مضبوط في الإعدادات — تعذّر حساب رسوم التوصيل والمسافة');
      }

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
    if (!order.handledBy && req.user) {
      order.handledBy = req.user._id;
      order.handledByName = handlerName(req.user);
    }
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

  /* الإلغاء للمدير وحده — في الاتجاهين: إلغاء طلب، أو إرجاع طلب ملغى.
     بدون الاتجاه الثاني يستطيع غير المدير عكس قرار الإلغاء. */
  const isAdmin = req.user && req.user.role === 'admin';
  if (!isAdmin && (status === 'cancelled' || previousStatus === 'cancelled')) {
    return res.status(403).json({ message: 'إلغاء الطلبات للمدير فقط' });
  }

  const update = { status };
  if (status === 'cancelled') {
    update.cancelledByName = handlerName(req.user);
    update.cancelReason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    update.cancelledAt = new Date();
  }

  const order = await Order.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });

  await claimHandler(order, req.user);

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
// POST /api/orders/pos — بيع مباشر من تطبيق DiyarPOS (سفري على الكاشير)
// ✅ كان مفقوداً تماماً، فكانت شاشة البيع في التطبيق تفشل عند إنشاء الطلب.
// الطلب هنا مؤكَّد فوراً ويدخل الجرد مباشرةً (لا يمرّ بمرحلة "معلّق").
const createPosOrder = async (req, res) => {
  try {
    const { items, paymentMethod, notes, printRequested, brand } = req.body;
    const channel = req.body.channel === 'web' ? 'web' : 'app';
    const clientRef = String(req.body.clientRef || '').trim().slice(0, 64);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'لا توجد أصناف في الطلب' });
    }

    /* شبكة الجوال تنقطع وتعود: لو ضاع الرد وأعاد المتصفح الإرسال بنفس
       المعرّف، نعيد الطلب الأول بدل بيعه مرتين. فهرس عادي لا فريد عمداً —
       الفهارس الفريدة القديمة سبق أن سببت «key مستخدم بالفعل». */
    if (clientRef) {
      const since = new Date(Date.now() - 30 * 60 * 1000);
      const existing = await Order.findOne({ clientRef, createdAt: { $gte: since } });
      if (existing) return res.status(200).json({ success: true, order: existing, duplicate: true });
    }

    // الأسعار تُحسَب من قاعدة البيانات لا من التطبيق
    const productIds = items.map((i) => i.product).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const finalItems = [];
    let itemsTotal = 0;

    for (const item of items) {
      const product = byId.get(String(item.product));
      if (!product) {
        return res.status(400).json({ success: false, message: `صنف غير موجود: ${item.nameAr || item.product}` });
      }

      const quantity = Math.max(parseInt(item.quantity, 10) || 1, 1);
      const addons = Array.isArray(item.addons)
        ? item.addons.map((a) => {
            const known = (product.addons || []).find((x) => x.name === a.name);
            return { name: a.name, price: known ? Number(known.price) || 0 : 0 };
          })
        : [];

      const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);
      const unitPrice = Number(product.price) + addonsTotal;
      itemsTotal += unitPrice * quantity;

      finalItems.push({
        product: product._id,
        nameAr: product.nameAr,
        price: unitPrice,
        quantity,
        addons,
        notes: String(item.notes || ''),
        printerName: '', // يُملأ بعد قليل من توجيه التصنيف
      });
    }

    // ✅ اسم طابعة القسم يُحسم من سلسلة التوجيه: التصنيف ← طابعته ← الرئيسية
    try {
      const groups = await printerService.groupOrderItemsByPrinter(finalItems);
      for (const group of groups) {
        const printerName = group.printer ? group.printer.name : '';
        for (const item of group.items) item.printerName = printerName;
      }
    } catch (e) {
      console.warn('تعذّر تحديد طابعات الأقسام:', e.message);
    }

    const total = itemsTotal;
    const orderNumber = await generateUniqueOrderNumber();

    const order = await Order.create({
      orderNumber,
      customerName: 'سفري',
      phone: '',
      address: '',
      items: finalItems,
      itemsTotal,
      deliveryFee: 0,
      total,
      paymentMethod: ['cash', 'card', 'online'].includes(paymentMethod) ? paymentMethod : 'cash',
      orderType: 'pickup',
      notes: String(notes || ''),
      brand: brand || 'diyar',
      source: 'pos',
      status: 'preparing',   // مؤكَّد فوراً — البيع تمّ على الكاشير
      confirmedAt: new Date(),
      printRequested: !!printRequested,
      posChannel: channel,
      clientRef,
      // البائع يملك الطلب: يدخل في جرده هو
      handledBy: req.user ? req.user._id : null,
      handledByName: handlerName(req.user),
    });

    console.log(`🧾 بيع مباشر ${orderNumber} بواسطة ${req.user ? req.user.username : 'غير معروف'} — ${total} د.أ`);

    try { realtime.emitOrderCreated(order); } catch (e) { console.error('realtime emit failed:', e.message); }

    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error('createPosOrder error:', err);
    res.status(500).json({ success: false, message: 'تعذر إنشاء طلب البيع المباشر', error: err.message });
  }
};

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

/**
 * ملخص الجرد من قائمة طلبات.
 *
 * المحقق: طلب المنصة عند تسليمه، وطلب السفري فور بيعه — لأنه يُنشأ بحالة
 * «جاري التحضير» ودُفع على الكاشير، ولا أحد يعلّمه «تم التسليم». سابقاً كان
 * يُحسب «معلّقاً» فيسقط من صافي المبيعات كلياً.
 */
const summarizeOrders = (orders, expenses = []) => {
  const isPos = (o) => o.source === 'pos';
  const isSuccess = (o) => o.status === 'delivered' || (isPos(o) && o.status !== 'cancelled');
  // 3 منازل: الدينار ألف فلس، والتقريب لمنزلتين يُفسد مطابقة نقد الصندوق
  const sum = (arr) => Number(arr.reduce((t, o) => t + Number(o.total || 0), 0).toFixed(3));

  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const success = orders.filter(isSuccess);
  const pendingList = orders.filter((o) => o.status !== 'cancelled' && !isSuccess(o));

  const platform = success.filter((o) => !isPos(o));
  const direct = success.filter(isPos);

  // التوصيل المحصَّل فعلاً: من طلبات المنصة المُسلَّمة فقط
  const deliveryTotal = Number(
    platform.reduce((t, o) => t + Number(o.deliveryFee || 0), 0).toFixed(3)
  );

  // المصروفات: الملغى يبقى أثراً للمراجعة لكنه خارج الحساب
  const liveExpenses = expenses.filter((e) => !e.voided);
  const expensesTotal = Number(liveExpenses.reduce((t, e) => t + Number(e.amount || 0), 0).toFixed(3));

  const times = orders.concat(expenses).map((o) => new Date(o.createdAt).getTime()).filter(Boolean);

  return {
    totalOrders: orders.length,
    successCount: success.length,
    successTotal: sum(success),
    platformCount: platform.length,
    platformTotal: sum(platform),
    directCount: direct.length,
    directTotal: sum(direct),
    deliveryTotal,
    pendingCount: pendingList.length,
    pendingTotal: sum(pendingList),
    cancelledCount: cancelled.length,
    cancelledTotal: sum(cancelled),
    expensesCount: liveExpenses.length,
    expensesTotal,
    // ما يجب أن يكون في الصندوق: المبيعات المحققة ناقص ما صُرف منها
    cashNet: Number((sum(success) - expensesTotal).toFixed(3)),
    firstAt: times.length ? new Date(Math.min(...times)) : null,
    generatedAt: new Date(),
  };
};

/** مصروفات جرد مفتوح: لصاحبها، أو للمطعم كله بنطاق المدير. */
const expenseFilter = (user, scope) => {
  const f = { closed: { $ne: true } };
  if (scope !== 'all') f.createdBy = user._id;
  return f;
};

const buildShiftSummary = async (filter) => summarizeOrders(await Order.find(filter).lean());

const canCloseAll = (user) => !!user && ['admin', 'manager'].includes(user.role);

/**
 * طلبات جرد مستخدم: ما تعامل معه هو، إضافة لطلبات ما قبل تفعيل الميزة
 * (بلا مالك ولم تعد معلّقة) — يأخذها أول من يُغلق، مرة واحدة.
 * الطلبات المعلّقة بلا مالك تبقى مفتوحة حتى يؤكدها أحد أو يلغيها.
 * scope='all' للمدير: جرد المطعم كله كما كان سابقاً.
 */
const shiftFilter = (user, scope, brand) => {
  const f = { closed: { $ne: true } };
  if (brand) f.brand = brand;
  if (scope === 'all') return f;
  f.$or = [
    { handledBy: user._id },
    { handledBy: null, status: { $ne: 'pending' } },
  ];
  return f;
};

const resolveScope = (user, requested) => (requested === 'all' && canCloseAll(user) ? 'all' : 'mine');

// GET /api/orders/shift-summary?scope=mine|all — معاينة الجرد قبل الإغلاق (لا تُغيّر شيئاً)
const getShiftSummary = async (req, res) => {
  try {
    const scope = resolveScope(req.user, req.query.scope);
    const [orders, expenses] = await Promise.all([
      Order.find(shiftFilter(req.user, scope, req.query.brand)).lean(),
      Expense.find(expenseFilter(req.user, scope)).lean(),
    ]);
    const summary = summarizeOrders(orders, expenses);
    res.json({
      success: true,
      summary: { ...summary, scope, userName: scope === 'all' ? 'جرد المطعم كاملاً' : handlerName(req.user) },
      canCloseAll: canCloseAll(req.user),
    });
  } catch (err) {
    res.status(500).json({ message: 'تعذر حساب ملخص الجرد', error: err.message });
  }
};

// GET /api/orders/shift-overview — للمدير: الجرد المفتوح لكل مستخدم على حدة
const getShiftOverview = async (req, res) => {
  try {
    const f = { closed: { $ne: true } };
    if (req.query.brand) f.brand = req.query.brand;
    const orders = await Order.find(f).lean();

    const groups = new Map();
    for (const o of orders) {
      const key = o.handledBy ? String(o.handledBy) : '';
      if (!groups.has(key)) groups.set(key, { name: o.handledByName || '', orders: [], expenses: [] });
      groups.get(key).orders.push(o);
    }

    // مستخدم صرف ولم يبع شيئاً يظهر أيضاً
    const expenses = await Expense.find({ closed: { $ne: true } }).lean();
    for (const e of expenses) {
      const key = String(e.createdBy);
      if (!groups.has(key)) groups.set(key, { name: e.createdByName || '', orders: [], expenses: [] });
      const g = groups.get(key);
      g.expenses.push(e);
      if (!g.name) g.name = e.createdByName || '';
    }

    const users = [...groups.entries()].map(([userId, g]) => ({
      userId: userId || null,
      name: userId ? g.name || 'مستخدم' : 'بلا مستخدم بعد',
      summary: summarizeOrders(g.orders, g.expenses),
    }));

    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ message: 'تعذر حساب الجرد المفتوح', error: err.message });
  }
};

// POST /api/orders/close-shift  { password, scope?: 'mine'|'all' }
// يتطلب كلمة مرور المستخدم نفسه، ثم يؤرشف طلباته ويعيد ملخص الجرد للطباعة
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

    const scope = resolveScope(req.user, req.body.scope);
    const [orders, expenses] = await Promise.all([
      Order.find(shiftFilter(req.user, scope, brand)).lean(),
      Expense.find(expenseFilter(req.user, scope)).lean(),
    ]);
    if (orders.length === 0 && expenses.length === 0) {
      return res.status(400).json({ message: 'لا توجد طلبات ولا مصروفات لإغلاقها حالياً' });
    }

    const summary = summarizeOrders(orders, expenses);
    const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const shiftId = `SHIFT-${stamp}-${scope === 'all' ? 'ALL' : user.username}`;

    /* الأرشفة بالمعرّفات نفسها التي حُسب منها الملخص: طلب يصل أثناء
       الإغلاق لا يُؤرشف خارج التقرير، بل يبقى للجرد القادم. */
    await Order.updateMany(
      { _id: { $in: orders.map((o) => o._id) }, closed: { $ne: true } },
      { $set: { closed: true, closedAt: new Date(), shiftId } }
    );

    // المصروفات تُؤرشف مع جرد صاحبها — الملغاة أيضاً لتبقى أثراً في أرشيفه
    if (expenses.length) {
      await Expense.updateMany(
        { _id: { $in: expenses.map((e) => e._id) }, closed: { $ne: true } },
        { $set: { closed: true, closedAt: new Date(), shiftId } }
      );
    }

    const userName = scope === 'all' ? 'جرد المطعم كاملاً' : handlerName(req.user);
    console.log(`📊 إغلاق جرد ${shiftId} بواسطة ${user.username} (${scope}) — محقق: ${summary.successCount} (${summary.successTotal}) | معلّقة: ${summary.pendingCount} | ملغاة: ${summary.cancelledCount} | مصروفات: ${summary.expensesTotal}`);

    res.json({
      success: true,
      shiftId,
      summary: { ...summary, scope, userName },
      message: 'تم إغلاق الجرد',
    });
  } catch (err) {
    res.status(500).json({ message: 'تعذر إغلاق الجرد', error: err.message });
  }
};

module.exports = wrapAll({
  getShiftSummary,
  getShiftOverview,
  closeShift, getOrders, getOrder, createOrder, confirmOrder, updateOrderStatus, getDashboardStats, getPrintQueue, markPrinted, createPosOrder, getBlockedPhones, blockPhone, unblockPhone });
