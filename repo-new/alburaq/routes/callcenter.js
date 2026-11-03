const express = require('express');
const cfg = require('../config');
const Store = require('../models/Store');
const Area = require('../models/Area');
const Trip = require('../models/Trip');
const { requireOperator } = require('../auth');
const { publicTrip } = require('../publicTrip');
const { getSettings } = require('../settings');
const { buildPriceSheet } = require('../services/priceSheet');
const { createTripForStore, httpError } = require('../services/dispatchService');
const printing = require('../services/printService');
const { invoiceHtml, priceSheetHtml } = require('../receipts');


const router = express.Router();
const { logoDataUri } = require('../receipts');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' }));

/* كول سنتر البراق — بنفس مستخدمي ديار، بصلاحية brq:center (دور «موظف شركة البراق» يملكها افتراضياً) */
router.use(requireOperator);

router.get('/me', (req, res) => res.json({ success: true, operator: { id: String(req.user._id), name: req.user.name } }));

/** GET /api/brq/callcenter/stores — المتاجر المفعّلة مع مواقعها */
router.get('/stores', wrap(async (_req, res) => {
  const stores = await Store.find({ active: true }).sort({ name: 1 }).lean();
  res.json({ success: true, stores: stores.map((s) => ({ id: String(s._id), name: s.name, phone: s.phone, location: s.location })) });
}));

router.get('/areas', wrap(async (_req, res) => {
  const areas = await Area.find({ active: true }).sort({ name: 1 }).lean();
  res.json({ success: true, areas: areas.map((a) => ({ id: String(a._id), name: a.name })) });
}));

/** GET /api/brq/callcenter/stores/:id/price-sheet — الحسبة الفورية للمنطقة */
router.get('/stores/:id/price-sheet', wrap(async (req, res) => {
  const store = await Store.findById(req.params.id).lean();
  if (!store) throw httpError(404, 'المتجر غير موجود');
  const [settings, areas] = await Promise.all([getSettings(), Area.find({ active: true }).lean()]);
  res.json({ success: true, sheet: buildPriceSheet(store.location, areas, settings) });
}));

/**
 * POST /api/brq/callcenter/orders
 *   { storeId, stops: [{ phone (إلزامي), areaId?, lat?, lng?, name?, note? }], print? }
 *   (أو الحقول المفردة areaId + customerPhone…) — رقم الزبون إلزامي، والمنطقة أو الموقع.
 * يُنشئ طلب سائق باسم المتجر، ويطبع الفاتورة إن طُلبت الطباعة.
 */
router.post('/orders', wrap(async (req, res) => {
  const store = await Store.findOne({ _id: req.body.storeId, active: true });
  if (!store) throw httpError(400, 'اختر متجراً صحيحاً');
  const trip = await createTripForStore(store, req.body, { kind: 'callcenter', by: req.user.name || '' });
  const settings = await getSettings();
  const quote = { estimateFils: trip.estimateFils };
  const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}`;
  // الفاتورة تُعاد للواجهة (تطبعها محلياً داخل DiyarPOS)، ومع remote تُرسل لجهاز الكاشير
  const html = req.body.print === false ? null : invoiceHtml({
        brand: cfg.brand, logoUrl: logoDataUri(), invoiceNo,
        storeName: store.name, areaName: trip.areaName, stops: trip.stops,
        customerName: req.body.customerName, customerPhone: trip.customer.phone,
        customerLocation: Number.isFinite(trip.customer.lat) ? { lat: trip.customer.lat, lng: trip.customer.lng } : null,
        estimateFils: quote ? quote.estimateFils : 0,
        meterFlagFils: settings.meterFlagFils, perKmFils: settings.perKmFils,
        operatorName: req.user.name,
      });
  const job = html && req.body.remote ? await printing.queue({ title: invoiceNo, html, user: req.user }) : null;
  res.status(201).json({ success: true, trip: publicTrip(trip, 'store'), invoiceNo, quoteFils: quote ? quote.estimateFils : null, invoiceHtml: html, printJob: job ? String(job._id) : null });
}));

/** POST /api/brq/callcenter/estimate  { storeId, stops: [{ areaId?, lat?, lng? }] } */
router.post('/estimate', wrap(async (req, res) => {
  const store = await Store.findById(req.body.storeId).lean();
  if (!store) throw httpError(404, 'المتجر غير موجود');
  const { estimateInput } = require('../services/priceSheet');
  res.json({ success: true, ...(await estimateInput(store.location, req.body.stops)) });
}));

/** GET /api/brq/callcenter/orders — آخر الطلبات */
router.get('/orders', wrap(async (_req, res) => {
  const trips = await Trip.find().sort({ requestedAt: -1 }).limit(50).lean();
  res.json({ success: true, trips: trips.map((t) => publicTrip(t, 'admin')) });
}));

/** POST /api/brq/callcenter/stores/:id/print-sheet  { format?, remote? } — كشف أسعار المتجر بالشعار والختم */
router.post('/stores/:id/print-sheet', wrap(async (req, res) => {
  const { priceSheetForStore } = require('../services/priceSheet');
  const { priceSheetA4Html } = require('../receipts');
  const st = await Store.findById(req.params.id).lean();
  if (!st) throw httpError(404, 'المتجر غير موجود');
  const [sheet, settings] = await Promise.all([priceSheetForStore(st), getSettings()]);
  const args = { brand: cfg.brand, logoUrl: logoDataUri(), storeName: st.name, storePhone: st.phone, storeLocation: st.location, sheet, settings };
  await printing.respond(req, res, { title: `كشف أسعار ${st.name}`, html: req.body.format === 'a4' ? priceSheetA4Html(args) : priceSheetHtml(args) });
}));

module.exports = router;
