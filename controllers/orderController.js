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
const crypto = require('crypto');
const ShiftSession = require('../models/ShiftSession');
const { logActivity } = require('../utils/activity');
const { touchOpenSession, ensureOpenSession, newShiftId, numbersFrom } = require('../services/shiftService');
const { deliveryState, deliveryStateFilter, DELIVERY_BASE } = require('../utils/deliveryState');

/** حدث في تسلسل الطلب (للتتبع وسجل التوصيل) — آخر 40 حدثاً فقط. */
const timelinePush = (event, user) => ({
  timeline: { $each: [{ event, at: new Date(), byName: (user && (user.name || user.username)) || '' }], $slice: -40 },
});

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 409 موحّد عند التضارب: يعيد الطلب كما هو الآن ليحدّث المستخدم شاشته. */
const conflict = async (res, id, message) => {
  const current = await Order.findById(id).lean();
  if (!current) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
  return res.status(409).json({
    success: false,
    code: 'CONFLICT',
    message: message || 'تغيّر هذا الطلب للتو من مستخدم آخر — تم تحديث البيانات، راجعها ثم أعد المحاولة',
    order: current,
  });
};

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
  // مبيعات السفري في شاشة البيع: source=pos، و mine=true لمبيعات المستخدم نفسه
  if (['web', 'pos', 'app', 'center'].includes(req.query.source)) filter.source = req.query.source;
  if (req.query.mine === 'true' && req.user) filter.handledBy = req.user._id;
  // سجل الطلبات: فترة، نوع، مندوب، حالة توصيل
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(`${req.query.from}T00:00:00+03:00`);
    if (req.query.to) filter.createdAt.$lt = new Date(new Date(`${req.query.to}T00:00:00+03:00`).getTime() + 86400000);
  }
  if (['delivery', 'pickup'].includes(req.query.orderType)) filter.orderType = req.query.orderType;
  if (req.query.driver && mongoose.Types.ObjectId.isValid(req.query.driver)) filter.driver = req.query.driver;
  const dsf = req.query.deliveryState ? deliveryStateFilter(req.query.deliveryState) : null;
  if (dsf) { Object.assign(filter, DELIVERY_BASE, dsf); }
  if (req.query.search) {
    const rx = { $regex: escRx(String(req.query.search).trim()), $options: 'i' };
    filter.$or = [
      { orderNumber: rx },
      { customerName: rx },
      { phone: rx },
      // الرقم المؤقت المطبوع على فاتورة بيعٍ تمّ بلا إنترنت
      { offlineNumber: rx },
      { driverName: rx },
    ];
  }
  const SORTS = { '-createdAt': { createdAt: -1 }, createdAt: { createdAt: 1 }, '-total': { total: -1 }, total: { total: 1 } };
  const sort = SORTS[req.query.sort] || { createdAt: -1 };

  const [orders, total] = await Promise.all([
    Order.find(filter).sort(sort).skip(skip).limit(Math.min(limit, 200)).lean(),
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
    o.deliveryState = o.orderType === 'delivery' && o.source !== 'pos' ? deliveryState(o) : '';
  });

  res.json({ data: orders, pagination: { total, page, pages: Math.ceil(total / limit), limit } });
};

// GET /api/orders/:id
const getOrder = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const order = await Order.findById(req.params.id).lean();
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  order.locationUrl = mapLink(order.customerLatitude, order.customerLongitude);
  order.deliveryState = order.orderType === 'delivery' && order.source !== 'pos' ? deliveryState(order) : '';
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

    /* منع الطلب المكرر (ضغط متكرر، إعادة اتصال، إعادة إرسال المتصفح):
       نفس معرّف العملية خلال 24 ساعة يعيد الطلب الأول ولا يُنشئ ثانياً. */
    const webClientRef = String(req.body.clientRef || '').trim().slice(0, 64);
    if (webClientRef) {
      const dup = await Order.findOne({
        clientRef: webClientRef,
        source: { $ne: 'pos' },
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }).select('+trackingToken');
      if (dup) {
        return res.status(200).json({
          success: true, duplicate: true, order: dup, orderNumber: dup.orderNumber,
          orderId: String(dup._id), trackingToken: dup.trackingToken || '',
        });
      }
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

    /* نسخ طابعة كل صنف من المنتج (تبقى ثابتة مع الطلب حتى لو تغيّرت لاحقاً)،
       والسعر من قاعدة البيانات: السعر القادم من الجهاز (سلة قديمة أو «إعادة طلب») ليس نهائياً.
       الصنف = سعره الحالي + أسعار إضافاته المعرّفة عليه؛ الإضافة غير المعرّفة تبقى كما أُرسلت. */
    try {
      const ids = normalizedItems.map((i) => i.product).filter(Boolean);
      if (ids.length) {
        const products = await Product.find({ _id: { $in: ids } }).select('printerName price addons').lean();
        const byId = new Map(products.map((p) => [String(p._id), p]));
        normalizedItems.forEach((i) => {
          if (!i.product) return;
          const p = byId.get(String(i.product));
          if (!p) return;
          i.printerName = p.printerName || '';
          if (typeof p.price === 'number') {
            const known = new Map((p.addons || []).map((a) => [String(a.name || '').trim(), Number(a.price || 0)]));
            i.addons = (i.addons || []).map((a) => {
              const k = String((a && a.name) || '').trim();
              return known.has(k) ? { name: k, price: known.get(k) } : { name: k, price: Number((a && a.price) || 0) };
            });
            const addonsTotal = i.addons.reduce((t, a) => t + Number(a.price || 0), 0);
            i.price = Number((p.price + addonsTotal).toFixed(3));
          }
        });
      }
    } catch (e) {
      console.error('تعذّر جلب أسعار/طابعات الأصناف:', e.message);
    }

    // ═══ حساب رسوم التوصيل في الخادم (مصدر الحقيقة) ═══
    // نتجاهل أي deliveryFee قادم من الواجهة ونعيد حسابه من الإحداثيات وإعدادات المطعم.
    const isDelivery = (orderType || 'delivery') !== 'pickup';
    // المجموع يُحسب دائماً من الأصناف بعد تسعيرها في الخادم
    const computedItemsTotal = Number(
      normalizedItems.reduce((t, i) => t + Number(i.price || 0) * Number(i.quantity || 1), 0).toFixed(3)
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
          itemsTotal: computedItemsTotal, // «حسب قيمة الطلب»: من أسعار الخادم لا الجهاز
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
      paymentMethod: ['cash', 'cliq', 'card'].includes(paymentMethod) ? paymentMethod : 'cash',
      orderType: orderType || 'delivery',
      brand: brand || 'diyar',
      notes: notes || '',
      status: 'pending',
      printRequested: printRequested === true,
      printed: false,
      clientRef: webClientRef,
      trackingToken: crypto.randomBytes(16).toString('hex'),
      timeline: [{ event: 'status:pending', at: new Date(), byName: '' }],
    });

    // سجل العميل: إنشاء إن لم يوجد، وتحديث بياناته إن وُجد (بلا تكرار)
    try {
      const existing = await Customer.findOne({ phone });
      // آخر موقع للزبون: يُعبّأ تلقائياً عندما يطلب لاحقاً هاتفياً من «بيع سنتر»
      const last = { lastOrderType: order.orderType, lastSource: 'web' };
      if (order.orderType === 'delivery') {
        last.lastAddressDetail = address || '';
        last.lastAddressOption = '';
        if (custLat != null) { last.lastLatitude = custLat; last.lastLongitude = custLng; }
      }
      if (existing) {
        existing.name = customerName || existing.name;
        if (address) existing.address = address;
        Object.assign(existing, last);
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
          ...last,
        });
      }
    } catch (e) { /* لا نُفشل الطلب إن تعذّر تحديث سجل العميل */ }

    // بثّ فوري لتطبيق الإدارة + إشعار FCM (لا يعطّلان إنشاء الطلب إن فشلا)
    try { realtime.emitOrderCreated(order); } catch (e) { console.error('realtime emit failed:', e.message); }
    pushService.notifyNewOrder(order).catch((e) => console.error('push failed:', e.message));

    res.status(201).json({
      success: true, order, orderNumber,
      // للزبون: متابعة الطلب وسجل طلباته من جهازه
      orderId: String(order._id), trackingToken: order.trackingToken,
    });
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
    /* 1) التأكيد ذرّي: الشرط status=pending داخل التحديث نفسه، فلو ضغط مستخدمان
       «تأكيد» في اللحظة نفسها ينجح واحد فقط، ولا يُحسب العميل والمخزون مرتين. */
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'new', confirmedAt: new Date() }, $push: timelinePush('status:new', req.user) },
      { new: true }
    );
    if (!order) {
      const exists = await Order.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
      return conflict(res, req.params.id, 'هذا الطلب أُكّد مسبقاً (ربما من مستخدم آخر) — تم تحديث البيانات');
    }
    await claimHandler(order, req.user);
    logActivity({ req, action: 'order.confirm', order, before: 'pending', after: 'new' });
    touchOpenSession(req.user);

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
      // نتحقق من الحقول المعدّلة فقط: منتج قديم ناقص حقلاً لا يُفشل تأكيد الطلب
      await product.save({ validateModifiedOnly: true });
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
  const previous = await Order.findById(req.params.id).select('status closed');
  const previousStatus = previous ? previous.status : null;

  // طلب دخل جرداً مغلقاً لا يُعدَّل: تغييره يُفسد تقريراً طُبع وسُلّم نقده
  if (previous && previous.closed) {
    return res.status(400).json({ message: 'هذا الطلب ضمن جرد مغلق ولا يمكن تعديله' });
  }

  /* الإلغاء للمدير وحده — في الاتجاهين: إلغاء طلب، أو إرجاع طلب ملغى.
     بدون الاتجاه الثاني يستطيع غير المدير عكس قرار الإلغاء. */
  const isAdmin = req.user && req.user.role === 'admin';
  if (!isAdmin && (status === 'cancelled' || previousStatus === 'cancelled')) {
    return res.status(403).json({ message: 'إلغاء الطلبات للمدير فقط' });
  }

  /* «خرج للتوصيل» لطلب توصيل يتطلب موظف توصيل معيَّناً — حين يكون للمطعم مندوبون.
     فلا يظهر للزبون «خرج للتوصيل» دون مندوب حقيقي. */
  if (status === 'out_for_delivery') {
    const cur = await Order.findById(req.params.id).select('orderType source driver').lean();
    if (cur && cur.orderType === 'delivery' && cur.source !== 'pos' && !cur.driver) {
      const User = require('../models/User');
      if (await User.exists({ role: 'delivery', isActive: true })) {
        return res.status(400).json({ message: 'عيّن موظف التوصيل أولاً قبل «خرج للتوصيل»' });
      }
    }
  }

  const update = { status };
  if (status === 'cancelled') {
    update.cancelledByName = handlerName(req.user);
    update.cancelReason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    update.cancelledAt = new Date();
  }
  if (status === 'out_for_delivery') update.outForDeliveryAt = new Date();
  if (status === 'delivered') update.deliveredAt = new Date();

  /* منع التضارب: إن أرسلت الواجهة الحالة التي رأتها (expectedStatus) فالتحديث
     مشروط بها — مستخدمان يغيّران الطلب نفسه معاً: ينجح الأول، ويُبلَّغ الثاني بالحالة الجديدة. */
  const filter = { _id: req.params.id, closed: { $ne: true } };
  const expected = req.body && req.body.expectedStatus;
  if (expected && validStatuses.concat('pending').includes(expected)) filter.status = expected;

  const order = await Order.findOneAndUpdate(
    filter,
    { $set: update, $push: timelinePush(`status:${status}`, req.user) },
    { new: true }
  );
  if (!order) {
    if (!previous) return res.status(404).json({ message: 'الطلب غير موجود' });
    return conflict(res, req.params.id);
  }

  await claimHandler(order, req.user);
  logActivity({
    req, order, before: previousStatus || '', after: status,
    action: status === 'cancelled' ? 'order.cancel' : status === 'delivered' ? 'order.complete' : 'order.status',
    details: status === 'cancelled' && update.cancelReason ? { reason: update.cancelReason } : undefined,
  });

  // بثّ فوري لتطبيق الإدارة
  try {
    if (status === 'cancelled') realtime.emitOrderCancelled(order);
    else realtime.emitOrderStatusChanged(order, previousStatus);
  } catch (e) {
    console.error('realtime emit failed:', e.message);
  }

  res.json(order);
};

// GET /api/orders/drivers — المندوبون المفعّلون (لاختيار من خرج بالطلب)
const getDrivers = async (req, res) => {
  const User = require('../models/User');
  const drivers = await User.find({ role: 'delivery', isActive: true }).select('name username phone').sort('name').lean();
  res.json({ success: true, data: drivers });
};

// PUT /api/orders/:id/driver  { driverId | null, expectedDriver? }
// يربط الطلب بموظف التوصيل. لا يغيّر حالة الطلب: «تم الإرسال» و«خرج للتوصيل»
// خطوتان مستقلتان يسجّلهما الخادم حين تحدثان فعلاً.
const assignDriver = async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  if (order.source === 'pos' || order.orderType === 'pickup') {
    return res.status(400).json({ message: 'هذا الطلب ليس طلب توصيل' });
  }
  if (['pending', 'cancelled', 'delivered'].includes(order.status)) {
    return res.status(400).json({
      message: order.status === 'pending' ? 'أكّد الطلب أولاً قبل تعيين المندوب' : 'لا يمكن تغيير مندوب طلب منتهٍ',
    });
  }
  if (order.closed || order.deliverySettled) {
    return res.status(400).json({ message: 'هذا الطلب ضمن جرد مغلق ولا يمكن تغيير مندوبه' });
  }

  const driverId = req.body && req.body.driverId;
  let set;
  if (driverId) {
    if (!mongoose.Types.ObjectId.isValid(driverId)) return res.status(400).json({ message: 'مندوب غير صالح' });
    const User = require('../models/User');
    const driver = await User.findOne({ _id: driverId, role: 'delivery', isActive: true }).select('name').lean();
    if (!driver) return res.status(400).json({ message: 'المندوب غير موجود أو غير مفعّل' });
    set = { driver: driver._id, driverName: driver.name, driverAssignedAt: new Date() };
  } else {
    set = { driver: null, driverName: '', driverAssignedAt: null };
  }
  // تغيّر المندوب = التفاصيل لم تصل للجديد بعد
  const changed = String(order.driver || '') !== String(set.driver || '');
  if (changed) { set.deliverySentAt = null; set.deliverySentByName = ''; }

  /* منع التضارب: إن أرسلت الواجهة المندوب الذي رأته (expectedDriver، والفارغ = بلا مندوب)
     فالتحديث مشروط به — لا يكتب مستخدم فوق تعيين زميله دون أن يعلم. */
  const filter = { _id: order._id, closed: { $ne: true }, status: { $nin: ['pending', 'cancelled', 'delivered'] } };
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedDriver')) {
    const exp = req.body.expectedDriver;
    filter.driver = exp && mongoose.Types.ObjectId.isValid(exp) ? exp : null;
  }

  const updated = await Order.findOneAndUpdate(
    filter,
    { $set: set, ...(changed ? { $push: timelinePush(set.driver ? 'driver_assigned' : 'driver_removed', req.user) } : {}) },
    { new: true }
  );
  if (!updated) return conflict(res, order._id, 'تغيّر مندوب هذا الطلب للتو من مستخدم آخر — تم تحديث البيانات');

  if (changed) {
    logActivity({
      req, order: updated, action: 'order.assign_driver',
      before: order.driverName || '', after: updated.driverName || '',
      details: { driverName: updated.driverName || '', previousDriver: order.driverName || '' },
    });
  }
  try { realtime.emitOrderUpdated(updated); } catch (e) { console.error('realtime emit failed:', e.message); }
  res.json(updated);
};

// PUT /api/orders/:id/payment  { paymentMethod: cash|cliq|card, expectedPaymentMethod? }
// طلب ضمن جرد مغلق لا يُعدَّل: تغييره يُفسد تقريراً طُبع وسُلّم نقده.
const setPaymentMethod = async (req, res) => {
  const method = req.body && req.body.paymentMethod;
  if (!['cash', 'cliq', 'card'].includes(method)) {
    return res.status(400).json({ message: 'طريقة دفع غير صالحة (نقدي، كليك، فيزا)' });
  }
  const filter = { _id: req.params.id, closed: { $ne: true } };
  const expected = req.body.expectedPaymentMethod;
  if (['cash', 'cliq', 'card', 'online'].includes(expected)) {
    filter.paymentMethod = expected === 'cash' ? { $in: ['cash', null] } : expected;
  }
  const before = await Order.findById(req.params.id).select('paymentMethod closed').lean();
  if (!before) return res.status(404).json({ message: 'الطلب غير موجود' });
  if (before.closed) return res.status(400).json({ message: 'هذا الطلب ضمن جرد مغلق ولا يمكن تعديل طريقة دفعه' });

  const updated = await Order.findOneAndUpdate(
    filter,
    { $set: { paymentMethod: method }, $push: timelinePush(`payment:${method}`, req.user) },
    { new: true }
  );
  if (!updated) return conflict(res, req.params.id, 'تغيّرت طريقة دفع هذا الطلب للتو من مستخدم آخر — تم تحديث البيانات');

  logActivity({ req, order: updated, action: 'order.payment', before: before.paymentMethod || 'cash', after: method });
  try { realtime.emitOrderUpdated(updated); } catch (e) { console.error('realtime emit failed:', e.message); }
  res.json(updated);
};

// POST /api/orders/:id/delivery-sent  { driverId }
// يُسجَّل «تم إرسال تفاصيل الطلب» قبل فتح رسالة المندوب: الخادم يؤكد أولاً،
// وإن فشل لا تُفتح الرسالة ولا تتغير الحالة.
const markDeliverySent = async (req, res) => {
  const driverId = req.body && req.body.driverId;
  if (!driverId || !mongoose.Types.ObjectId.isValid(driverId)) {
    return res.status(400).json({ message: 'اختر موظف التوصيل أولاً' });
  }
  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    {
      _id: req.params.id,
      driver: driverId,                 // التفاصيل تُرسل للمندوب المعيَّن فعلاً فقط
      closed: { $ne: true },
      status: { $in: ['new', 'preparing', 'ready', 'out_for_delivery'] },
    },
    {
      $set: { deliverySentAt: now, deliverySentByName: handlerName(req.user) },
      $push: timelinePush('delivery_sent', req.user),
    },
    { new: true }
  );
  if (!updated) {
    const cur = await Order.findById(req.params.id).lean();
    if (!cur) return res.status(404).json({ message: 'الطلب غير موجود' });
    if (String(cur.driver || '') !== String(driverId)) {
      return conflict(res, cur._id, 'المندوب المعيَّن لهذا الطلب تغيّر — تم تحديث البيانات');
    }
    return res.status(400).json({ message: 'لا يمكن إرسال طلب منتهٍ أو ضمن جرد مغلق' });
  }

  logActivity({
    req, order: updated, action: 'order.delivery_sent',
    details: { driverName: updated.driverName || '' },
  });
  try { realtime.emitOrderUpdated(updated); } catch (e) { console.error('realtime emit failed:', e.message); }
  res.json(updated);
};

/* ═══════════ تتبع الطلب وسجل الزبون (عام — برمز التتبع) ═══════════ */
const { publicOrder, tokenMatches } = require('../utils/publicOrder');

// GET /api/orders/track/:id?token=  — حالة طلب واحد للزبون
const trackOrder = async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
  const order = await Order.findById(id).select('+trackingToken').lean();
  // رمز خاطئ = «غير موجود»: لا نكشف وجود طلبات الآخرين
  if (!order || !tokenMatches(order.trackingToken, req.query.token)) {
    return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
  }
  res.json({ success: true, order: publicOrder(order) });
};

// POST /api/orders/track  { refs: [{ id, token }] } — سجل طلباتي من هذا الجهاز (حتى 50)
const trackBatch = async (req, res) => {
  const refs = Array.isArray(req.body && req.body.refs) ? req.body.refs.slice(0, 50) : [];
  const valid = refs.filter((r) => r && mongoose.Types.ObjectId.isValid(r.id) && typeof r.token === 'string');
  if (!valid.length) return res.json({ success: true, data: [] });
  const tokens = new Map();
  valid.forEach((r) => {
    const k = String(r.id);
    if (!tokens.has(k)) tokens.set(k, []);
    tokens.get(k).push(r.token);
  });
  const orders = await Order.find({ _id: { $in: [...tokens.keys()] } }).select('+trackingToken').sort({ createdAt: -1 }).lean();
  const data = orders
    .filter((o) => tokens.get(String(o._id)).some((t) => tokenMatches(o.trackingToken, t)))
    .map(publicOrder);
  res.json({ success: true, data });
};

// GET /api/orders/my?page=  — كل طلبات رقم الزبون الموثّق (دخول برقم الهاتف)
const myOrders = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const intl = String(req.phoneUser.phone || '');           // +9627XXXXXXXX
  const local = intl.startsWith('+962') ? `0${intl.slice(4)}` : intl; // 07XXXXXXXX
  const filter = { phone: { $in: [local, intl] }, source: { $ne: 'pos' } };
  const [orders, total] = await Promise.all([
    Order.find(filter).select('+trackingToken').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  // الرمز يُعاد لصاحب الرقم الموثّق فقط، ليتابع الطلب لحظياً
  const data = orders.map((o) => ({ ...publicOrder(o), token: o.trackingToken || '' }));
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
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
      { $group: { _id: null, total: { $sum: { $subtract: ['$total', { $ifNull: ['$deliveryFee', 0] }] } } } }, // بلا رسوم التوصيل
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfMonth }, ...confirmedFilter } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$total', { $ifNull: ['$deliveryFee', 0] }] } } } }, // بلا رسوم التوصيل
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

    // بيع بلا إنترنت من جهاز الكاشير: رقمه المطبوع ووقته الفعلي (ضمن آخر 7 أيام فقط)
    const offlineNumber = String(req.body.offlineNumber || '').trim().slice(0, 24);
    let offlineSoldAt = null;
    if (offlineNumber && req.body.soldAt) {
      const t = new Date(req.body.soldAt);
      const now = Date.now();
      if (!isNaN(t) && t.getTime() <= now + 5 * 60 * 1000 && t.getTime() >= now - 7 * 24 * 60 * 60 * 1000) {
        offlineSoldAt = t;
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'لا توجد أصناف في الطلب' });
    }

    /* شبكة الجوال تنقطع وتعود: لو ضاع الرد وأعاد المتصفح الإرسال بنفس
       المعرّف، نعيد الطلب الأول بدل بيعه مرتين. فهرس عادي لا فريد عمداً —
       الفهارس الفريدة القديمة سبق أن سببت «key مستخدم بالفعل».
       7 أيام: جهاز الكاشير يزامن مبيعات بلا إنترنت بعد ساعات أو أيام. */
    if (clientRef) {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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
      paymentMethod: ['cash', 'cliq', 'card'].includes(paymentMethod) ? paymentMethod : 'cash',
      orderType: 'pickup',
      notes: String(notes || ''),
      brand: brand || 'diyar',
      source: 'pos',
      status: 'preparing',   // مؤكَّد فوراً — البيع تمّ على الكاشير
      confirmedAt: new Date(),
      printRequested: !!printRequested,
      posChannel: channel,
      clientRef,
      offlineNumber,
      offlineSoldAt,
      // البائع يملك الطلب: يدخل في جرده هو
      handledBy: req.user ? req.user._id : null,
      handledByName: handlerName(req.user),
    });

    if (offlineNumber) console.log(`📴 مزامنة بيع بلا إنترنت ${offlineNumber} → ${orderNumber}`);
    logActivity({ req, order, action: 'pos.sale', after: order.status, details: offlineNumber ? { offlineNumber } : undefined });
    touchOpenSession(req.user);
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
    logActivity({ req, action: 'phone.block', details: { phone, reason: reason || '' } });
    res.json({ success: true, blocked });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حظر الرقم', error: err.message });
  }
};

const unblockPhone = async (req, res) => {
  try {
    await BlockedPhone.findOneAndDelete({ phone: req.params.phone });
    logActivity({ req, action: 'phone.unblock', details: { phone: req.params.phone } });
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
 * المحقق: كل طلب مؤكَّد غير ملغى — طلب المنصة لحظة تأكيده من «حالة الطلبات»
 * (أيّاً كانت حالته بعدها)، وطلب السفري فور بيعه.
 * سابقاً كان طلب المنصة لا يُحسب إلا بعد «تم التسليم»، فكانت الطلبات
 * المؤكَّدة كلها تسقط في «المعلّقة» ويظهر جرد المنصة صفراً دائماً.
 * المعلّق = طلب منصة لم يؤكده أحد بعد (pending) فقط.
 */
/** قيمة البيع الفعلية للمطعم: الإجمالي ناقص رسوم التوصيل. */
const salesValue = (o) => Math.max(0, Number(o.total || 0) - Number(o.deliveryFee || 0));

/** طريقة دفع الطلب: القديم بلا طريقة = نقدي؛ «أونلاين» القديم يُحسب مع الفيزا (بطاقة). */
const payOf = (o) => {
  const m = o.paymentMethod || 'cash';
  return m === 'online' ? 'card' : m;
};

/** مجموع وعدد كل طريقة دفع (بقيمة الأصناف — التوصيل للمندوب). */
const paymentTotals = (success) => {
  const pick = (m) => success.filter((o) => payOf(o) === m);
  const r = (arr) => Number(arr.reduce((t, o) => t + salesValue(o), 0).toFixed(3));
  const cash = pick('cash');
  const cliq = pick('cliq');
  const card = pick('card');
  return {
    cashCount: cash.length, cashTotal: r(cash),
    cliqCount: cliq.length, cliqTotal: r(cliq),
    cardCount: card.length, cardTotal: r(card),
    otherPaymentsTotal: Number((r(cliq) + r(card)).toFixed(3)),
  };
};

/**
 * تفصيل المنتجات: كل منتج باسمه (لا التصنيف) — الكمية المباعة وقيمتها، من الطلبات المحققة فقط.
 * القيمة = سعر السطر (شامل إضافاته) × الكمية، وهو نفس ما دخل المبيعات.
 */
const productBreakdown = (orders) => {
  const map = new Map();
  for (const o of orders) {
    for (const it of o.items || []) {
      const name = String(it.nameAr || it.name || '').trim() || 'صنف';
      const key = it.product ? `p:${it.product}` : `n:${name}`;
      if (!map.has(key)) map.set(key, { name, quantity: 0, value: 0 });
      const row = map.get(key);
      const qty = Number(it.quantity || 1);
      row.quantity += qty;
      row.value += Number(it.price || 0) * qty;
    }
  }
  return [...map.values()]
    .map((r) => ({ ...r, value: Number(r.value.toFixed(3)) }))
    .sort((a, b) => b.quantity - a.quantity || b.value - a.value || a.name.localeCompare(b.name, 'ar'));
};

/** تسديدات ذمم الموردين غير المؤرشفة: لمن سدّدها، أو للمطعم كله في الجرد الكامل. */
const loadCollections = (user, scope) => {
  const Receivable = require('../models/Receivable');
  // من رأس المال لم يخرج من أي درج: لا يدخل الجرد
  const f = { status: 'paid', deleted: { $ne: true }, collectionClosed: { $ne: true }, paySource: { $ne: 'capital' } };
  // صاحب الصندوق المختار؛ والسجلات القديمة (بلا اختيار) لمن سدّد
  if (scope !== 'all') f.$or = [{ drawerUser: user._id }, { drawerUser: null, paidBy: user._id }];
  return Receivable.find(f).sort({ paidAt: 1 }).lean();
};

const summarizeOrders = (orders, expenses = [], delivery = null, collections = []) => {
  const isPos = (o) => o.source === 'pos';
  const isSuccess = (o) => o.status !== 'pending' && o.status !== 'cancelled';
  // 3 منازل: الدينار ألف فلس، والتقريب لمنزلتين يُفسد مطابقة نقد الصندوق
  // كل الأرقام بقيمة الأصناف فقط: رسوم التوصيل ليست مبيعات المطعم
  const sum = (arr) => Number(arr.reduce((t, o) => t + salesValue(o), 0).toFixed(3));

  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const success = orders.filter(isSuccess);
  const pendingList = orders.filter((o) => o.status !== 'cancelled' && !isSuccess(o));

  const isCenter = (o) => o.source === 'center';
  const platform = success.filter((o) => !isPos(o) && !isCenter(o));
  const center = success.filter(isCenter);
  const direct = success.filter(isPos);

  const fees = (arr) => Number(arr.reduce((t, o) => t + Number(o.deliveryFee || 0), 0).toFixed(3));

  // توصيل طلبات هذا الجرد: يظهر لكل مستخدم للعلم فقط، ولا يدخل أي مجموع
  const withFee = platform.concat(center).filter((o) => Number(o.deliveryFee || 0) > 0);

  // دفتر التوصيل (الأدمن): مستحقات المندوبين، مفصّلة لكل مندوب
  const deliveryTotal = delivery ? fees(delivery) : 0;
  let deliveryByDriver = [];
  if (delivery) {
    const groups = new Map();
    for (const o of delivery) {
      const key = o.driver ? String(o.driver) : '';
      if (!groups.has(key)) groups.set(key, { driverId: key || null, name: key ? o.driverName || 'مندوب' : 'بلا مندوب', list: [] });
      groups.get(key).list.push(o);
    }
    deliveryByDriver = [...groups.values()]
      .map((g) => ({
        driverId: g.driverId,
        name: g.name,
        count: g.list.length,
        salesTotal: sum(g.list),       // قيمة الأصناف: يسلّمها المندوب للمطعم
        deliveryTotal: fees(g.list),   // أجرة المندوب
      }))
      .sort((a, b) => (a.driverId ? 0 : 1) - (b.driverId ? 0 : 1) || b.count - a.count);
  }

  // المصروفات: الملغى يبقى أثراً للمراجعة لكنه خارج الحساب
  const liveExpenses = expenses.filter((e) => !e.voided);
  const expensesTotal = Number(liveExpenses.reduce((t, e) => t + Number(e.amount || 0), 0).toFixed(3));

  const times = orders.concat(expenses).map((o) => new Date(o.createdAt).getTime()).filter(Boolean);

  return {
    totalOrders: orders.length,
    successCount: success.length,
    successTotal: sum(success),
    // كل منتج باسمه وكميته وقيمته (المحققة فقط)
    products: productBreakdown(success),
    // طرق الدفع: نقدي (والقديم بلا طريقة دفع)، كليك، فيزا — عدداً ومجموعاً
    ...paymentTotals(success),
    platformCount: platform.length,
    platformTotal: sum(platform),
    directCount: direct.length,
    directTotal: sum(direct),
    // بيع سنتر: الطلبات الهاتفية (منفصلة عن المنصة والسفري)
    centerCount: center.length,
    centerTotal: sum(center),
    // دفتر التوصيل (null لغير الأدمن): مستحقات المندوبين، خارج المبيعات والصندوق
    deliveryInfoCount: withFee.length,
    deliveryInfoTotal: fees(withFee),
    deliveryIncluded: !!delivery,
    deliveryCount: delivery ? delivery.length : 0,
    deliveryTotal,
    deliveryByDriver,
    pendingCount: pendingList.length,
    pendingTotal: sum(pendingList),
    cancelledCount: cancelled.length,
    cancelledTotal: sum(cancelled),
    expensesCount: liveExpenses.length,
    // المصروفات سطراً سطراً (تُطبع في الجرد بدل الدفتر الورقي) — بترتيب تسجيلها
    expenseItems: liveExpenses
      .slice()
      .sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt))
      .map((e) => ({ number: e.number || null, name: e.name || '', amount: Number(Number(e.amount || 0).toFixed(3)), at: e.createdAt || null, by: e.createdByName || '' })),
    // الصافي = مجموع البيع (بدون توصيل) − المصروفات − ما سُدّد للموردين
    netAfterExpenses: Number((sum(success) - expensesTotal
      - (collections || []).reduce((t, r) => t + Number(r.amount || 0), 0)).toFixed(3)),
    // تسديد ذمم الموردين: مال خرج في هذا الجرد عن فواتير خارجية سابقة
    supplierPayments: (collections || []).map((r) => ({
      number: r.number || null, name: r.customerName || '', invoiceNumber: r.invoiceNumber || '',
      amount: Number(Number(r.amount || 0).toFixed(3)),
      method: r.paymentMethod || 'cash', by: r.paidByName || '', at: r.paidAt || null,
      drawer: r.drawerUserName || r.paidByName || '',
    })),
    supplierPaymentsCount: (collections || []).length,
    supplierPaymentsTotal: Number((collections || []).reduce((t, r) => t + Number(r.amount || 0), 0).toFixed(3)),
    supplierPaymentsCash: Number((collections || []).filter((r) => (r.paymentMethod || 'cash') === 'cash').reduce((t, r) => t + Number(r.amount || 0), 0).toFixed(3)),
    expensesTotal,
    // ما يجب أن يكون في الصندوق: المبيعات المحققة ناقص ما صُرف منها
    // (التوصيل لا يدخل: المندوب يحصّله من الزبون ويحتفظ به)
    // ما في الدرج فعلاً: النقدي فقط ناقص المصروفات (كليك وفيزا لا تدخل الصندوق)
    // − ما سُدّد للموردين نقداً من الدرج في هذا الجرد
    cashNet: Number((sum(success.filter((o) => payOf(o) === 'cash'))
      - (collections || []).filter((r) => (r.paymentMethod || 'cash') === 'cash').reduce((t, r) => t + Number(r.amount || 0), 0)
      - expensesTotal).toFixed(3)),
    firstAt: times.length ? new Date(Math.min(...times)) : null,
    generatedAt: new Date(),
  };
};

/** مصروفات جرد مفتوح: لصاحبها، أو للمطعم كله بنطاق المدير. */
const expenseFilter = (user, scope) => {
  // مصروفات رأس المال لم تخرج من الدرج: لا تدخل أي جرد
  const f = { closed: { $ne: true }, source: { $ne: 'capital' } };
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

/**
 * دفتر التوصيل — للأدمن وحده، وفي «جرد المطعم كاملاً» فقط.
 * كل طلب منصة مؤكَّد برسوم توصيل ولم تُسوَّ رسومه بعد، سواء أُغلق في جرد
 * كاشير أو مدير أم لا — فلا تضيع رسوم ولا تُحسب مرتين.
 * يبدأ الدفتر من DELIVERY_LEDGER_START: الطلبات الأقدم دخل توصيلها جرودها القديمة.
 */
const DELIVERY_LEDGER_START = new Date(process.env.DELIVERY_LEDGER_START || '2026-09-28T00:00:00+03:00');

const canSettleDelivery = (user, scope) => scope === 'all' && !!user && user.role === 'admin';

const deliveryLedgerFilter = (brand) => {
  const f = {
    source: { $ne: 'pos' },
    status: { $nin: ['pending', 'cancelled'] },
    deliveryFee: { $gt: 0 },
    deliverySettled: { $ne: true },
    confirmedAt: { $gte: DELIVERY_LEDGER_START },
  };
  if (brand) f.brand = brand;
  return f;
};

const loadDeliveryLedger = (user, scope, brand) =>
  canSettleDelivery(user, scope) ? Order.find(deliveryLedgerFilter(brand)).lean() : Promise.resolve(null);

const resolveScope = (user, requested) => (requested === 'all' && canCloseAll(user) ? 'all' : 'mine');

// GET /api/orders/shift-summary?scope=mine|all — معاينة الجرد قبل الإغلاق (لا تُغيّر شيئاً)
const getShiftSummary = async (req, res) => {
  try {
    const scope = resolveScope(req.user, req.query.scope);
    const [orders, expenses, delivery, collections] = await Promise.all([
      Order.find(shiftFilter(req.user, scope, req.query.brand)).lean(),
      Expense.find(expenseFilter(req.user, scope)).lean(),
      loadDeliveryLedger(req.user, scope, req.query.brand),
      loadCollections(req.user, scope),
    ]);
    const summary = summarizeOrders(orders, expenses, delivery, collections);
    if (scope === 'all') summary.byUser = userSummaries(orders, expenses, collections);
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
/**
 * جرد كل مستخدم على حدة من طلبات ومصروفات معطاة: من تعامل مع الطلب، ومن سجّل المصروف.
 * كل عنصر ملخص جرد كامل بصيغة «جرد المستخدم» (مع تفصيل منتجاته) — يُطبع ورقةً مستقلة.
 */
const groupByUser = (orders, expenses, collections = []) => {
  const groups = new Map();
  for (const o of orders) {
    const key = o.handledBy ? String(o.handledBy) : '';
    if (!groups.has(key)) groups.set(key, { name: o.handledByName || '', orders: [], expenses: [], collections: [] });
    groups.get(key).orders.push(o);
  }
  for (const e of expenses) {
    const key = String(e.createdBy);
    if (!groups.has(key)) groups.set(key, { name: e.createdByName || '', orders: [], expenses: [], collections: [] });
    const g = groups.get(key);
    g.expenses.push(e);
    if (!g.name) g.name = e.createdByName || '';
  }
  for (const r of collections) {
    const owner = r.drawerUser || r.paidBy;
    const key = owner ? String(owner) : '';
    if (!groups.has(key)) groups.set(key, { name: (r.drawerUser ? r.drawerUserName : r.paidByName) || '', orders: [], expenses: [], collections: [] });
    groups.get(key).collections.push(r);
  }
  return [...groups.entries()].map(([userId, g]) => ({
    userId: userId || null,
    name: userId ? g.name || 'مستخدم' : 'بلا مستخدم بعد',
    orders: g.orders,
    expenses: g.expenses,
    collections: g.collections,
  }));
};

/** ملخصات المستخدمين داخل جرد المطعم كاملاً — من له عملية فعلية فقط. */
const userSummaries = (orders, expenses, collections = []) =>
  groupByUser(orders, expenses, collections)
    .map((g) => ({ userId: g.userId, userName: g.name, scope: 'mine', ...summarizeOrders(g.orders, g.expenses, null, g.collections) }))
    .filter((u) => u.successCount || u.cancelledCount || u.expensesCount || u.supplierPaymentsCount)
    .sort((a, b) => b.successTotal - a.successTotal);

const getShiftOverview = async (req, res) => {
  try {
    const f = { closed: { $ne: true } };
    if (req.query.brand) f.brand = req.query.brand;
    const orders = await Order.find(f).lean();
    // مستخدم صرف ولم يبع شيئاً يظهر أيضاً
    const expenses = await Expense.find({ closed: { $ne: true } }).lean();
    const users = groupByUser(orders, expenses).map((g) => ({
      userId: g.userId,
      name: g.name,
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
    const [orders, expenses, delivery, collections] = await Promise.all([
      Order.find(shiftFilter(req.user, scope, brand)).lean(),
      Expense.find(expenseFilter(req.user, scope)).lean(),
      loadDeliveryLedger(req.user, scope, brand),
      loadCollections(req.user, scope),
    ]);
    if (orders.length === 0 && expenses.length === 0 && !collections.length && !(delivery && delivery.length)) {
      return res.status(400).json({ message: 'لا توجد طلبات ولا مصروفات لإغلاقها حالياً' });
    }

    const summary = summarizeOrders(orders, expenses, delivery, collections);
    // جرد المطعم كاملاً = جرد لكل مستخدم داخله، يُطبع لكلٍّ ورقة مستقلة
    if (scope === 'all') summary.byUser = userSummaries(orders, expenses, collections);
    /* الدورة: جرد المستخدم يُغلق دورته المفتوحة (تُفتح الآن إن لم يفتحها)، فيبقى
       المعرّف نفسه من الفتح إلى الإغلاق. جرد المطعم كاملاً دورة مستقلة. */
    const openSession = scope === 'all' ? null : await ensureOpenSession(req.user, { auto: true });
    const shiftId = openSession ? openSession.shiftId : newShiftId(user, 'all');

    /* الأرشفة بالمعرّفات نفسها التي حُسب منها الملخص: طلب يصل أثناء
       الإغلاق لا يُؤرشف خارج التقرير، بل يبقى للجرد القادم. */
    /* الطلب غير المؤكَّد (pending) يظهر في التقرير للعلم لكنه لا يُؤرشف:
       لو أُرشف لاختفى من «حالة الطلبات» قبل أن يؤكده أحد ويضيع على الزبون. */
    await Order.updateMany(
      { _id: { $in: orders.filter((o) => o.status !== 'pending').map((o) => o._id) }, closed: { $ne: true } },
      { $set: { closed: true, closedAt: new Date(), shiftId } }
    );

    // المصروفات تُؤرشف مع جرد صاحبها — الملغاة أيضاً لتبقى أثراً في أرشيفه
    if (expenses.length) {
      await Expense.updateMany(
        { _id: { $in: expenses.map((e) => e._id) }, closed: { $ne: true } },
        { $set: { closed: true, closedAt: new Date(), shiftId } }
      );
    }

    // تسوية التوصيل: بالمعرّفات نفسها التي دخلت التقرير
    if (delivery && delivery.length) {
      await Order.updateMany(
        { _id: { $in: delivery.map((o) => o._id) }, deliverySettled: { $ne: true } },
        { $set: { deliverySettled: true, deliverySettledAt: new Date(), deliveryShiftId: shiftId } }
      );
    }

    const userName = scope === 'all' ? 'جرد المطعم كاملاً' : handlerName(req.user);

    // حفظ الدورة: من أغلق ومتى، وملخص الأرقام كما طُبع — لا يُمسح بفتح دورة جديدة
    try {
      const now = new Date();
      const closeFields = {
        status: 'closed', closedAt: now, closedBy: req.user._id, closedByName: handlerName(req.user),
        periodEnd: now, summary: { ...summary, scope, userName }, ...numbersFrom(summary),
      };
      if (openSession) {
        await ShiftSession.updateOne({ _id: openSession._id }, { $set: closeFields });
      } else {
        await ShiftSession.create({
          shiftId, scope: 'all', user: req.user._id, userName: 'جرد المطعم كاملاً',
          openedAt: summary.firstAt || now, openedBy: req.user._id, openedByName: handlerName(req.user),
          ...closeFields,
        });
        // جرد المطعم كاملاً أرشف طلبات الجميع: دوراتهم المفتوحة تُغلق معه
        await ShiftSession.updateMany(
          { scope: 'mine', status: 'open' },
          { $set: { status: 'closed', closedAt: now, closedBy: req.user._id, closedByName: handlerName(req.user), closedViaShiftId: shiftId, periodEnd: now } }
        );
      }
    } catch (e) {
      console.error('حفظ دورة الجرد تعذّر:', e.message); // الإغلاق نفسه تمّ — لا نُفشله
    }
    // تسديدات الموردين دخلت هذا الجرد: تُؤرشف فلا تُحسب مرة ثانية
    if (collections.length) {
      try {
        await require('../models/Receivable').updateMany(
          { _id: { $in: collections.map((r) => r._id) }, collectionClosed: { $ne: true } },
          { $set: { collectionClosed: true, collectionShiftId: shiftId } }
        );
      } catch (e) { console.error('أرشفة تحصيل الذمم تعذّرت:', e.message); }
    }
    logActivity({ req, action: 'shift.close', amount: summary.successTotal, details: { shiftId, scope, ordersCount: summary.successCount } });
    try { realtime.emitShiftClosed(shiftId, scope); } catch (_) { /* البث لا يُفشل الإغلاق */ }

    console.log(`📊 إغلاق جرد ${shiftId} بواسطة ${user.username} (${scope}) — محقق: ${summary.successCount} (${summary.successTotal}) | معلّقة: ${summary.pendingCount} | ملغاة: ${summary.cancelledCount} | مصروفات: ${summary.expensesTotal} | توصيل للمندوبين: ${summary.deliveryCount} (${summary.deliveryTotal})`);

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
  getDrivers,
  assignDriver,
  markDeliverySent,
  setPaymentMethod,
  trackOrder,
  trackBatch,
  myOrders,
  closeShift, getOrders, getOrder, createOrder, confirmOrder, updateOrderStatus, getDashboardStats, getPrintQueue, markPrinted, createPosOrder, getBlockedPhones, blockPhone, unblockPhone });
