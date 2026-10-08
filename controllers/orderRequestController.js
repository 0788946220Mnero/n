/**
 * رسائل الزبون على طلبه (من صفحة التتبع) — بديل «إعادة الطلب»:
 *   nudge  تذكير المطعم بتأكيد الطلب (للطلب المعلّق فقط، مرة كل 3 دقائق)
 *   note   ملاحظة نصية للمطعم
 *   add    أصناف إضافية على نفس الطلب — لا تدخل الطلب ولا الفاتورة ولا الجرد
 *          إلا بعد «قبول» الموظف، وأسعارها من قاعدة البيانات لا من الجهاز.
 *
 * الزبون يُعرَّف برمز التتبع السري فقط، والموظف يقبل/يرفض/يعلّم «تم الاطلاع».
 */
const mongoose = require('mongoose');
const { wrapAll } = require('../utils/asyncHandler');
const Order = require('../models/Order');
const Product = require('../models/Product');
const realtime = require('../services/realtimeService');
const pushService = require('../services/pushService');
const { publicOrder, tokenMatches, REQ_ACTIVE, REQ_ADDABLE } = require('../utils/publicOrder');
const { logActivity } = require('../utils/activity');

const MAX_REQUESTS = 20;           // لكل طلب
const MIN_GAP_MS = 15 * 1000;      // بين رسالتين من نفس الطلب
const NUDGE_GAP_MS = 3 * 60 * 1000;
const MAX_ADD_LINES = 30;

const round3 = (n) => Number(Number(n || 0).toFixed(3));
const nameOf = (u) => (u && (u.name || u.username)) || '';
const KIND_LABEL = { nudge: 'تذكير بالتأكيد', note: 'ملاحظة', add: 'إضافة أصناف' };

/** أصناف الإضافة: منتجات حقيقية متوفرة، بأسعارها وإضافاتها الحالية من القاعدة. */
const priceAddItems = async (raw) => {
  const lines = (Array.isArray(raw) ? raw : []).slice(0, MAX_ADD_LINES)
    .filter((i) => i && i.product && mongoose.Types.ObjectId.isValid(i.product));
  if (!lines.length) return { error: 'اختر الأصناف التي تريد إضافتها' };
  const products = await Product.find({ _id: { $in: lines.map((l) => l.product) } }).select('nameAr price addons isAvailable printerName').lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const off = [];
  const items = [];
  for (const l of lines) {
    const p = byId.get(String(l.product));
    if (!p) continue;
    if (p.isAvailable === false) { off.push(p.nameAr); continue; }
    const known = new Map((p.addons || []).map((a) => [String(a.name || '').trim(), Number(a.price || 0)]));
    // إضافة غير معرّفة على المنتج تُترك (لا سعر من الجهاز)
    const addons = (Array.isArray(l.addons) ? l.addons : [])
      .map((a) => String((a && a.name) || '').trim())
      .filter((n) => known.has(n))
      .map((n) => ({ name: n, price: known.get(n) }));
    const qty = Math.min(50, Math.max(1, parseInt(l.quantity || l.qty, 10) || 1));
    items.push({
      product: p._id,
      nameAr: p.nameAr,
      quantity: qty,
      price: round3(Number(p.price || 0) + addons.reduce((t, a) => t + a.price, 0)),
      addons,
      printerName: p.printerName || '',
      notes: String(l.notes || '').slice(0, 120),
    });
  }
  if (off.length) return { error: `غير متوفر حالياً: ${off.join('، ')}` };
  if (!items.length) return { error: 'الأصناف المختارة غير موجودة في القائمة' };
  return { items, amount: round3(items.reduce((t, i) => t + i.price * i.quantity, 0)) };
};

// POST /api/orders/track/:id/request  { token, kind, text, items }
const createRequest = async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
  const order = await Order.findById(id).select('+trackingToken').lean();
  if (!order || !tokenMatches(order.trackingToken, b.token)) {
    return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
  }

  const kind = ['nudge', 'note', 'add'].includes(b.kind) ? b.kind : '';
  if (!kind) return res.status(400).json({ success: false, message: 'نوع الرسالة غير صالح' });

  if (order.closed || !REQ_ACTIVE.includes(order.status)) {
    return res.status(409).json({ success: false, code: 'ORDER_FINISHED', message: 'انتهى هذا الطلب — لا يمكن إرسال رسائل عليه', order: publicOrder(order) });
  }
  const list = order.customerRequests || [];
  if (list.length >= MAX_REQUESTS) {
    return res.status(429).json({ success: false, message: 'وصلت للحد الأقصى من الرسائل على هذا الطلب. للاستفسار اتصل بالمطعم.' });
  }
  const last = list[list.length - 1];
  if (last && Date.now() - new Date(last.createdAt).getTime() < MIN_GAP_MS) {
    return res.status(429).json({ success: false, message: 'وصلت رسالتك السابقة للتو — انتظر لحظات قبل إرسال أخرى' });
  }

  const text = String(b.text || '').trim().slice(0, 300);
  const request = { _id: new mongoose.Types.ObjectId(), kind, text: '', items: [], amount: 0, status: 'open', createdAt: new Date() };
  let allowed = REQ_ACTIVE;

  if (kind === 'nudge') {
    if (order.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'تم تأكيد طلبك بالفعل', order: publicOrder(order) });
    }
    const lastNudge = [...list].reverse().find((r) => r.kind === 'nudge');
    if (lastNudge && Date.now() - new Date(lastNudge.createdAt).getTime() < NUDGE_GAP_MS) {
      return res.status(429).json({ success: false, message: 'أرسلت تذكيراً قبل قليل — المطعم اطّلع عليه، وسيؤكَّد طلبك خلال لحظات' });
    }
    allowed = ['pending'];
  } else if (kind === 'note') {
    if (!text) return res.status(400).json({ success: false, message: 'اكتب ملاحظتك أولاً' });
    request.text = text;
  } else {
    if (!REQ_ADDABLE.includes(order.status)) {
      return res.status(409).json({ success: false, message: 'بدأ تجهيز طلبك للتسليم — لا يمكن الإضافة عليه الآن. يمكنك إرسال طلب جديد.', order: publicOrder(order) });
    }
    const priced = await priceAddItems(b.items);
    if (priced.error) return res.status(400).json({ success: false, message: priced.error });
    request.items = priced.items;
    request.amount = priced.amount;
    request.text = text;
    allowed = REQ_ADDABLE;
  }

  // الشرط داخل التحديث نفسه: لا رسالة على طلب انتهى/أُغلق في نفس اللحظة
  const r = await Order.updateOne(
    { _id: order._id, closed: { $ne: true }, status: { $in: allowed } },
    { $push: { customerRequests: request } }
  );
  const fresh = await Order.findById(order._id).lean();
  if (!r.modifiedCount && !r.nModified) {
    return res.status(409).json({ success: false, message: 'تغيّرت حالة طلبك للتو — راجعها ثم أعد المحاولة', order: publicOrder(fresh) });
  }

  try { realtime.emitOrderRequest(fresh, request); } catch (e) { console.error('realtime emit failed:', e.message); }
  pushService.notifyOrderRequest(fresh, request).catch(() => {});
  console.log(`📩 الطلب #${fresh.orderNumber}: ${KIND_LABEL[kind]} من الزبون${kind === 'add' ? ` (${request.amount} د.أ)` : ''}`);

  const pub = publicOrder(fresh);
  res.status(201).json({ success: true, request: pub.requests.find((x) => x.id === String(request._id)), order: pub });
};

// PUT /api/orders/:id/requests/:rid  { action: accept|reject|seen, reply }
const resolveRequest = async (req, res) => {
  const { id, rid } = req.params;
  const action = String((req.body && req.body.action) || '');
  const reply = String((req.body && req.body.reply) || '').trim().slice(0, 200);
  if (!['accept', 'reject', 'seen'].includes(action)) return res.status(400).json({ success: false, message: 'إجراء غير صالح' });
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });

  // قراءة ثم كتابة مشروطة بأن الطلب لم يتغيّر بينهما (يُعاد المحاولة تلقائياً عند تزامن بسيط)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const order = await Order.findById(id).lean();
    if (!order) return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    const reqs = (order.customerRequests || []).map((x) => ({ ...x }));
    const target = reqs.find((x) => String(x._id) === String(rid));
    if (!target) return res.status(404).json({ success: false, message: 'الرسالة غير موجودة' });
    if (target.status !== 'open') {
      const label = { accepted: 'قُبلت', rejected: 'رُفضت', seen: 'عُلّمت مقروءة' }[target.status] || 'عولجت';
      return res.status(409).json({ success: false, code: 'CONFLICT', message: `${label} مسبقاً${target.resolvedByName ? ` من ${target.resolvedByName}` : ''}`, order });
    }
    const finalAction = action === 'accept' && target.kind !== 'add' ? 'seen' : action;

    const set = {};
    target.status = { accept: 'accepted', reject: 'rejected', seen: 'seen' }[finalAction];
    target.reply = reply;
    target.resolvedAt = new Date();
    target.resolvedByName = nameOf(req.user);
    set.customerRequests = reqs;

    if (finalAction === 'accept') {
      if (order.closed || ['delivered', 'cancelled'].includes(order.status)) {
        return res.status(409).json({ success: false, message: 'الطلب انتهى أو أُغلق جرده — لا يمكن إضافة أصناف عليه. ارفض الإضافة واطلب من الزبون طلباً جديداً.', order });
      }
      const items = [...(order.items || []), ...(target.items || [])];
      const itemsTotal = round3(items.reduce((t, i) => t + Number(i.price || 0) * Number(i.quantity || 1), 0));
      set.items = items;
      set.itemsTotal = itemsTotal;
      let deliveryFee = Number(order.deliveryFee || 0);
      if (order.orderType === 'delivery' && order.source !== 'pos') {
        try {
          const st = await require('../models/Setting').findOne().lean();
          const dcfg = (st && st.delivery) || {};
          if (dcfg.pricingMode === 'byValue') {
            // الرسوم تتبع القيمة الجديدة — ولا ترتفع بإضافة أصناف
            const { feeForValue } = require('../services/deliveryFeeService');
            deliveryFee = Math.min(deliveryFee, feeForValue(itemsTotal, dcfg).fee);
            set.deliveryFee = deliveryFee;
          }
        } catch (_) { /* تبقى الرسوم كما هي */ }
      }
      set.total = Number((itemsTotal + deliveryFee).toFixed(2));
      set.timeline = [...(order.timeline || []), { event: 'items_added', at: new Date(), byName: nameOf(req.user) }].slice(-40);
    }

    const w = await Order.updateOne({ _id: order._id, updatedAt: order.updatedAt }, { $set: set });
    if (!w.modifiedCount && !w.nModified) continue; // تغيّر الطلب بين القراءة والكتابة → نعيد

    const fresh = await Order.findById(order._id);
    const done = (fresh.customerRequests || []).find((x) => String(x._id) === String(rid));
    try { realtime.emitOrderRequest(fresh, done); } catch (e) { console.error('realtime emit failed:', e.message); }
    logActivity({
      req,
      action: `order.request.${finalAction}`,
      order: fresh,
      amount: finalAction === 'accept' ? target.amount : null,
      details: { kind: target.kind, reply },
    });
    return res.json({ success: true, order: fresh, request: done, addedItems: finalAction === 'accept' ? target.items : [] });
  }
  return res.status(409).json({ success: false, code: 'CONFLICT', message: 'الطلب يتغيّر الآن من مستخدم آخر — أعد المحاولة بعد لحظة' });
};

module.exports = wrapAll({ createRequest, resolveRequest });
