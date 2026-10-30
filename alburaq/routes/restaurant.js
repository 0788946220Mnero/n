/**
 * /api/brq/restaurant — ربط «حالة الطلبات» في المطعم بشركة البراق:
 * أي طلب توصيل (من السنتر أو منصة الزبائن) يُرسل منه طلب سائق بنفس آلية المتاجر،
 * باسم «متجر المطعم» المحدد في إعدادات البراق، وببيانات الطلب نفسه (الاسم، الرقم، الموقع، العنوان).
 * حالة السائق تعود للطلب في المطعم لحظياً (order.brq).
 */
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../../models/Order');
const Store = require('../models/Store');
const Area = require('../models/Area');
const Trip = require('../models/Trip');
const Settings = require('../models/Settings');
const { requireStaff, PERM } = require('../auth');
const { publicTrip } = require('../publicTrip');
const { haversineKm, isValidPoint } = require('../geo');
const dispatch = require('../services/dispatchService');
const { estimateStops } = require('../services/priceSheet');
const { getSettings } = require('../settings');

const router = express.Router();
const httpError = (status, message) => Object.assign(new Error(message), { status });
const OPEN = ['searching', 'assigned', 'picked'];

router.use(requireStaff(PERM.request, PERM.manage));

/** «عبدون» = «عبدون » = «منطقة عبدون» — مطابقة اسم منطقة المطعم مع مناطق البراق */
const norm = (s) => String(s || '').replace(/^\s*(منطقة|حي)\s+/, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();

async function loadContext(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw httpError(400, 'معرّف غير صالح');
  const order = await Order.findById(orderId).lean();
  if (!order) throw httpError(404, 'الطلب غير موجود');
  if (order.orderType === 'pickup' || order.source === 'pos') throw httpError(400, 'هذا ليس طلب توصيل');
  if (order.status === 'cancelled') throw httpError(400, 'الطلب ملغى');
  const s = await Settings.findOne({ key: 'main' }).select('restaurantStore').lean();
  const store = s && s.restaurantStore ? await Store.findById(s.restaurantStore) : null;
  if (!store || !store.active) throw httpError(409, 'حدّد «متجر المطعم» أولاً من شركة البراق ← التسعير والإعدادات');
  const areas = await Area.find({ active: true }).sort({ name: 1 }).lean();
  const loc = { lat: order.customerLatitude, lng: order.customerLongitude };
  const hasLoc = isValidPoint(loc);
  let area = order.addressOption ? areas.find((a) => norm(a.name) === norm(order.addressOption)) : null;
  if (!area && hasLoc) area = areas.filter((a) => isValidPoint(a.center)).sort((x, y) => haversineKm(loc, x.center) - haversineKm(loc, y.center))[0] || null;
  return { order, store, areas, hasLoc, loc, area };
}

const orderView = (o) => ({
  id: String(o._id), orderNumber: o.orderNumber, customerName: o.customerName || '', phone: o.phone || '',
  address: o.address || '', addressOption: o.addressOption || '', source: o.source, total: o.total,
  location: isValidPoint({ lat: o.customerLatitude, lng: o.customerLongitude }) ? { lat: o.customerLatitude, lng: o.customerLongitude } : null,
  brq: o.brq || null,
});

/** GET /api/brq/restaurant/orders/:id/preview — ما سيُرسل: الزبون، المنطقة المقترحة، والتقدير */
router.get('/orders/:id/preview', async (req, res) => {
  const c = await loadContext(req.params.id);
  const settings = await getSettings();
  const est = estimateStops(c.store.location, [{ lat: c.hasLoc ? c.loc.lat : null, lng: c.hasLoc ? c.loc.lng : null, areaCenter: c.area ? c.area.center : null }], settings);
  const active = await Trip.findOne({ 'source.order': c.order._id, status: { $in: OPEN } }).lean();
  res.json({
    success: true,
    order: orderView(c.order),
    store: { id: String(c.store._id), name: c.store.name },
    areas: c.areas.map((a) => ({ id: String(a._id), name: a.name })),
    suggestedAreaId: c.area ? String(c.area._id) : null,
    estimate: est,
    activeTrip: active ? publicTrip(active, 'admin') : null,
  });
});

/**
 * POST /api/brq/restaurant/orders/:id/request  { areaId?, lat?, lng?, note? }
 * يرسل طلب سائق للبراق بموقع الزبون من الطلب (أو المنطقة/الرابط إن لم يكن له موقع).
 */
router.post('/orders/:id/request', async (req, res) => {
  const c = await loadContext(req.params.id);
  if (await Trip.exists({ 'source.order': c.order._id, status: { $in: OPEN } })) throw httpError(409, 'أُرسل سائق البراق لهذا الطلب مسبقاً');
  const b = req.body || {};
  const lat = b.lat !== undefined && b.lat !== null && b.lat !== '' ? Number(b.lat) : (c.hasLoc ? c.loc.lat : undefined);
  const lng = b.lng !== undefined && b.lng !== null && b.lng !== '' ? Number(b.lng) : (c.hasLoc ? c.loc.lng : undefined);
  const note = [c.order.address, `طلب المطعم ${c.order.orderNumber}`, b.note].filter(Boolean).join(' — ').slice(0, 200);
  const trip = await dispatch.createTripForStore(c.store, {
    stops: [{
      phone: c.order.phone, name: c.order.customerName || '', note,
      areaId: b.areaId || (c.area ? String(c.area._id) : undefined),
      lat, lng, source: b.lat !== undefined ? 'link' : 'order',
    }],
  }, {
    kind: 'restaurant', order: c.order._id, orderNumber: c.order.orderNumber,
    channel: c.order.source, by: (req.user && (req.user.name || req.user.username)) || '',
  });
  await syncOrder(trip);
  res.status(201).json({ success: true, trip: publicTrip(trip, 'admin') });
});

/** POST /api/brq/restaurant/orders/:id/cancel — إلغاء سائق البراق قبل الاستلام */
router.post('/orders/:id/cancel', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError(400, 'معرّف غير صالح');
  const t = await Trip.findOne({ 'source.order': req.params.id, status: { $in: ['searching', 'assigned'] } }).lean();
  if (!t) throw httpError(409, 'لا يوجد طلب سائق يمكن إلغاؤه');
  const trip = await dispatch.cancelTrip(t._id, { admin: true });
  res.json({ success: true, trip: publicTrip(trip, 'admin') });
});

/* ── مزامنة الطلب في المطعم مع رحلة البراق (اسم السائق وحالته على بطاقة الطلب) ── */
let diyarRealtime = null;
const LABEL = { searching: 'بحث عن سائق', assigned: 'السائق في الطريق للمطعم', picked: 'السائق في الطريق للزبون', completed: 'تم التسليم', expired: 'لا سائق متاح', cancelled: 'أُلغي' };

async function syncOrder(trip) {
  if (!trip || !trip.source || trip.source.kind !== 'restaurant' || !trip.source.order) return;
  const brq = {
    trip: trip._id, status: trip.status, label: LABEL[trip.status] || trip.status,
    driverName: trip.driverName || '', receiptNo: trip.receiptNo || '', updatedAt: new Date(),
  };
  const order = await Order.findByIdAndUpdate(trip.source.order, { $set: { brq } }, { new: true });
  if (order && diyarRealtime && diyarRealtime.emitOrderUpdated) { try { diyarRealtime.emitOrderUpdated(order); } catch (_) {} }
}

function init(rt) {
  diyarRealtime = rt;
  dispatch.onTripChanged(syncOrder);
}

module.exports = { router, init, syncOrder };
