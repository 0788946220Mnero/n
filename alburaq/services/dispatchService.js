/**
 * محرّك التوزيع — دورة حياة طلب السائق:
 *
 *   searching ──قبول السائق──▶ assigned ──المتجر يؤكد الاستلام──▶ picked ──السائق يسلّم عند الزبون──▶ completed
 *       │                          │                                  (هنا تبدأ الرحلة وتُحسب فتحة العداد)     (هنا تُحسب الكيلومترات الهوائية)
 *       ├─ لا سائق ─▶ expired      └─ إلغاء قبل الاستلام ─▶ cancelled
 *
 * • كل موجة: أقرب N سائق مؤهلين، ولكل منهم مهلة قبول (offerTimeoutSec).
 * • أول من يقبل يفوز (تحديث ذرّي). الحالة في قاعدة البيانات، فإعادة التشغيل لا تُضيع طلباً.
 * • التسعير يُثبَّت لحظة الاستلام (لقطة الإعدادات)، فتغيير الأسعار لاحقاً لا يمس الرحلة الجارية.
 * • الكيلومتر الهوائي: المتجر ← الزبون الأول ← الثاني …، يُحسب عند تسليم كل نقطة من GPS السائق.
 * • التسليم مسموح في أي مكان (لا منع للمناطق البعيدة)؛ البعد عن موقع محدد مسبقاً يُعلَّم للمراجعة.
 */
const mongoose = require('mongoose');
const cfg = require('../config');
const Trip = require('../models/Trip');
const Driver = require('../models/Driver');
const Area = require('../models/Area');
const Rating = require('../models/Rating');
const realtime = require('../realtime');
const Store = require('../models/Store');
const { getSettings } = require('../settings');
const { pickCandidates, lowRatedDriverIds } = require('../dispatch');
const { deliveryPricing } = require('../pricing');
const { haversineKm, isValidPoint, isWithinMeters } = require('../geo');
const { normalizePhone } = require('../security');
const { publicTrip } = require('../publicTrip');
const { publicDriver } = require('../publicDriver');
const { driverEta } = require('../eta');

const SWEEP_MS = 1000; // فحص كل ثانية حتى لا تتأخر الموجة التالية عن المهلة
const MAX_OPEN_PER_STORE = Number(process.env.MAX_OPEN_PER_STORE || 15);
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** مستمعون لتغيّر الطلب (مثل مزامنة «حالة الطلبات» في المطعم). */
const tripHooks = [];
function onTripChanged(fn) { tripHooks.push(fn); }

/** يبث الطلب لكل طرف بالشكل المناسب له (الزبون يظهر حسب مرحلة الرحلة). */
/* ── إشعارات المتجر على جواله (حتى والصفحة مغلقة): قبول السائق، وصوله، التسليم، لا سائق، الإلغاء ── */
const lastStatus = new Map(); // tripId → آخر حالة أُشعر بها المتجر
const arrivedNotified = new Set(); // tripId — «السائق وصل» مرة واحدة
const STORE_LINK = './?as=store';

/** إشعار دفع لكل أجهزة المتجر المسجّلة (يحذف الرموز الميتة). */
async function pushToStore(storeId, message) {
  const push = require('./push');
  const s = await Store.findById(storeId, { pushTokens: 1 }).lean();
  const tokens = (s && s.pushTokens) || [];
  if (!tokens.length) return;
  const res = await push.sendToTokens(tokens, { ...message, data: { link: STORE_LINK, ...(message.data || {}) } });
  if (res.invalidTokens.length) await Store.updateOne({ _id: storeId }, { $pull: { pushTokens: { $in: res.invalidTokens } } });
}

function notifyStoreStatus(trip, cancelledByStore = false) {
  const id = String(trip._id);
  const prev = lastStatus.get(id);
  if (prev === trip.status) return;
  lastStatus.set(id, trip.status);
  if (lastStatus.size > 5000) lastStatus.delete(lastStatus.keys().next().value);
  if (!prev && trip.status === 'searching') return; // الطلب أُرسل للتو من المتجر نفسه
  const to = (title, body, urgent = false) => pushToStore(trip.store, { title, body, urgent, tag: 'trip-' + id, data: { kind: 'trip', tripId: id } })
    .catch((e) => console.error('store push:', e.message));
  if (trip.status === 'assigned') to(`✅ قبل ${trip.driverName || 'السائق'} طلبك`, `في الطريق إليك لاستلام طلب ${trip.areaName} — افتح لترى مكانه وكم يحتاج`, true);
  else if (trip.status === 'completed') to('✅ تم تسليم الطلب', `${trip.areaName}${trip.receiptNo ? ' · ' + trip.receiptNo : ''} — قيّم السائق`);
  else if (trip.status === 'expired') to('⚠️ لا يوجد سائق متاح الآن', `طلب ${trip.areaName} لم يقبله أحد — أعد الطلب بعد قليل`, true);
  else if (trip.status === 'cancelled' && !cancelledByStore) to('⛔ أُلغي طلب التوصيل', `طلب ${trip.areaName} أُلغي من إدارة البراق`, true);
}

function publishTrip(trip, { cancelledByStore = false } = {}) {
  for (const h of tripHooks) { try { Promise.resolve(h(trip)).catch(() => {}); } catch (_) {} }
  try { notifyStoreStatus(trip, cancelledByStore); } catch (_) { /* الإشعار لا يعطّل البث */ }
  realtime.toStore(trip.store, { type: 'trip.updated', trip: publicTrip(trip, 'store') });
  realtime.toAdmins({ type: 'trip.updated', trip: publicTrip(trip, 'admin') });
  realtime.toOperators({ type: 'trip.updated', trip: publicTrip(trip, 'admin') });
  if (trip.driver) realtime.toDriver(trip.driver, { type: 'trip.updated', trip: publicTrip(trip, 'driver') });
  if (trip.driver && ['assigned', 'picked'].includes(trip.status)) publishDriverEta(trip).catch(() => {});
}

/** المتجر يرى السائق المقبول: اسمه، رقمه، مركبته، موقعه، وكم يحتاج للوصول (يُحدَّث مع كل موقع يرسله السائق). */
async function publishDriverEta(trip, driverDoc = null) {
  const d = driverDoc || (await Driver.findById(trip.driver).select('name phone vehicle plate lastLocation ratingSum ratingCount').lean());
  const info = driverEta(trip, d);
  if (!info) return null;
  const tid = String(trip._id);
  if (info.arrived && info.target === 'store' && trip.status === 'assigned' && !arrivedNotified.has(tid)) {
    arrivedNotified.add(tid);
    if (arrivedNotified.size > 5000) arrivedNotified.delete(arrivedNotified.values().next().value);
    pushToStore(trip.store, { title: `🛵 ${info.driver.name} وصل إلى المطعم`, body: `جهّز طلب ${trip.areaName} وسلّمه للسائق`, urgent: true, tag: 'trip-' + tid, data: { kind: 'trip', tripId: tid } })
      .catch((e) => console.error('store push:', e.message));
  }
  realtime.toStore(trip.store, { type: 'trip.driver', ...info });
  realtime.toAdmins({ type: 'trip.driver', ...info });
  return info;
}

/** من مسار موقع السائق: كل رحلاته المفتوحة تُبلغ متاجرها بموقعه ووقت وصوله. */
async function onDriverMoved(driverDoc) {
  const open = await Trip.find({ driver: driverDoc._id, status: { $in: ['assigned', 'picked'] } }).lean();
  for (const t of open) await publishDriverEta(t, driverDoc).catch(() => {});
}

/** طلب جديد (متجر/كول سنتر/مطعم): إشعار على أجهزة الإدارة المثبّتة — «انقر لتتبع الطلب». */
function notifyNewTrip(trip) {
  try {
    const alerts = require('../../services/staffAlertService');
    const by = trip.source && trip.source.kind;
    alerts.emit('brq.trip', {
      userName: trip.storeName,
      details: { store: trip.storeName, area: trip.areaName, stops: (trip.stops || []).length || 1, estimate: trip.estimateFils, by, orderNumber: trip.source && trip.source.orderNumber },
    });
  } catch (_) { /* الإشعار لا يعطّل الطلب أبداً */ }
}

function publishDriver(driver) {
  realtime.toAdmins({ type: 'driver.updated', driver: publicDriver(driver) });
}

async function driverSnapshots(now = Date.now(), maxTrips = 1) {
  const list = await Driver.find({ active: true }).lean();
  return list.map((d) => {
    const online = !!d.lastLocation && !!d.lastLocation.at && now - new Date(d.lastLocation.at).getTime() < cfg.locationStaleMs;
    return {
      id: String(d._id), active: d.active, online, status: d.status,
      hasCurrentTrip: (d.currentTrips || []).length >= maxTrips,
      lastLocation: d.lastLocation && isValidPoint(d.lastLocation) ? d.lastLocation : null,
    };
  });
}

async function storeRatingsByDriver(storeId) {
  const rows = await Rating.aggregate([
    { $match: { store: new mongoose.Types.ObjectId(String(storeId)) } },
    { $group: { _id: '$driver', avg: { $avg: '$stars' } } },
  ]);
  return rows.map((r) => ({ driver: String(r._id), avg: r.avg }));
}

/** يفتح موجة عرض جديدة. لا سائق مؤهل → expired. */
async function openNextWave(tripId, now = new Date()) {
  const trip = await Trip.findById(tripId);
  if (!trip || trip.status !== 'searching') return null;

  const settings = await getSettings();
  const [drivers, ratings] = await Promise.all([driverSnapshots(now.getTime(), settings.maxConcurrentTrips), storeRatingsByDriver(trip.store)]);
  const candidates = pickCandidates({
    drivers,
    store: trip.storeLocation,
    excludeIds: new Set(trip.offers.map((o) => String(o.driver))),
    lowRatedIds: lowRatedDriverIds(ratings, settings.minStoreRatingForDriver),
    radiusKm: settings.searchRadiusKm,
    count: settings.waveSize,
  });

  if (!candidates.length) {
    const r = await Trip.updateOne({ _id: trip._id, status: 'searching' }, { $set: { status: 'expired', waveEndsAt: null } });
    if (r.modifiedCount) publishTrip(await Trip.findById(trip._id));
    return null;
  }

  const wave = trip.wave + 1;
  const waveEndsAt = new Date(now.getTime() + settings.offerTimeoutSec * 1000);
  const newOffers = candidates.map((c) => ({ driver: c.id, wave, sentAt: now, status: 'sent' }));
  const r = await Trip.updateOne(
    { _id: trip._id, status: 'searching', wave: trip.wave },
    { $push: { offers: { $each: newOffers } }, $set: { wave, waveEndsAt } }
  );
  if (!r.modifiedCount) return null; // فتحها طلب آخر أو تغيّرت الحالة

  const fresh = await Trip.findById(trip._id);
  for (const c of candidates) {
    realtime.toDriver(c.id, {
      type: 'offer',
      offer: {
        tripId: String(trip._id),
        storeName: trip.storeName,
        areaName: trip.areaName,
        stopsCount: (trip.stops || []).length || 1,
        estimateFils: trip.estimateFils ?? null,
        distanceToStoreKm: c.distanceKm,
        // ما يعرفه السائق قبل القبول: فتحة العداد وسعر الكم وحصته من الكيلومتر
        meterFlagFils: settings.meterFlagFils,
        perKmFils: settings.perKmFils,
        driverPerKmFils: settings.perKmFils - settings.companyCutPerKmFils,
        wave,
        expiresAt: waveEndsAt,
      },
    });
  }
  publishTrip(fresh);
  notifyOfferPush(candidates.map((c) => c.id), fresh).catch((e) => console.error('offer push:', e.message));
  return fresh;
}

/** إشعار بيانات لسائقين بعينهم (يحذف الرموز الميتة). */
async function pushToDrivers(driverIds, message) {
  const push = require('./push');
  const list = await Driver.find({ _id: { $in: driverIds }, pushTokens: { $exists: true, $ne: [] } }, { pushTokens: 1 }).lean();
  const tokens = list.flatMap((d) => d.pushTokens);
  if (!tokens.length) return;
  const res = await push.sendToTokens(tokens, message);
  if (res.invalidTokens.length) {
    await Driver.updateMany({ pushTokens: { $in: res.invalidTokens } }, { $pull: { pushTokens: { $in: res.invalidTokens } } });
  }
}

/**
 * عرض الطلب كإشعار قوي: تطبيق السائق يعرضه ملء الشاشة بصوت إنذار حتى والشاشة مقفلة،
 * ويقبل/يرفض منه مباشرة. يصل لكل مرشح (والتطبيق يتجاهله إن كانت الصفحة مفتوحة أمامه).
 */
async function notifyOfferPush(driverIds, trip, { reminder = false } = {}) {
  const settings = await getSettings();
  const expiresAt = trip.waveEndsAt ? new Date(trip.waveEndsAt) : new Date(Date.now() + settings.offerTimeoutSec * 1000);
  const left = (expiresAt - Date.now()) / 1000;
  if (left < 2) return;
  // تذكير قبل انتهاء المهلة لمن لم يرد بعد: يرنّ ويهتز مرة ثانية (نفس الإشعار — لا تكرار في القائمة)
  if (!reminder && left >= 8) {
    const t = setTimeout(async () => {
      try {
        const fresh = await Trip.findById(trip._id, { status: 1, wave: 1, offers: 1, waveEndsAt: 1, storeName: 1, areaName: 1, stops: 1, estimateFils: 1 }).lean();
        if (!fresh || fresh.status !== 'searching' || fresh.wave !== trip.wave) return;
        const waiting = (fresh.offers || []).filter((o) => o.status === 'sent' && driverIds.some((id) => String(id) === String(o.driver))).map((o) => o.driver);
        if (waiting.length) await notifyOfferPush(waiting, fresh, { reminder: true });
      } catch (e) { console.error('offer reminder:', e.message); }
    }, Math.round(left * 500));
    if (t.unref) t.unref();
  }
  await pushToDrivers(driverIds, {
    title: reminder ? '🚨 طلب وارد — لم ترد بعد!' : '🚨 طلب وارد — البراق',
    body: `${trip.storeName} ← ${trip.areaName}${reminder ? ' · ثوانٍ وينتقل لغيرك' : ''}`,
    urgent: true,
    ttlSec: Math.max(1, (expiresAt - Date.now()) / 1000),
    tag: `offer-${trip._id}`,
    data: {
      kind: 'offer', link: './?as=driver', tripId: String(trip._id), storeName: trip.storeName, areaName: trip.areaName,
      stopsCount: (trip.stops || []).length || 1, estimateFils: trip.estimateFils ?? '',
      meterFlagFils: settings.meterFlagFils, driverPerKmFils: settings.perKmFils - settings.companyCutPerKmFils,
      expiresAt: expiresAt.toISOString(),
    },
  });
}

/** يغلق إشعار العرض عند من لم يقبله (قبله غيره، أُلغي، أو انتهت المهلة). */
function notifyOfferClosed(driverIds, tripId) {
  if (!driverIds.length) return;
  pushToDrivers(driverIds, { title: '', body: '', ttlSec: 30, data: { kind: 'offer.closed', tripId: String(tripId) } })
    .catch((e) => console.error('offer closed push:', e.message));
}

const MAX_STOPS = 10;

/**
 * يحوّل مدخلات الطلب إلى نقاط تسليم. يقبل stops: [...] أو الحقول المفردة القديمة
 * (areaId, customerPhone, customerName, customerLat, customerLng).
 * لكل نقطة: رقم الزبون إلزامي، ومنطقة أو موقع (رابط/خريطة) — أحدهما على الأقل.
 */
async function buildStops(body) {
  const raw = Array.isArray(body.stops) && body.stops.length
    ? body.stops
    : [{ areaId: body.areaId, phone: body.customerPhone, name: body.customerName, lat: body.customerLat, lng: body.customerLng, source: body.customerLocationSource }];
  if (raw.length > MAX_STOPS) throw httpError(400, `الحد ${MAX_STOPS} مواقع في الطلب الواحد`);
  const areas = await Area.find({ active: true }).lean();
  const byId = new Map(areas.map((a) => [String(a._id), a]));
  const label = (i) => (raw.length > 1 ? ` (الموقع ${i + 1})` : '');

  return raw.map((r, i) => {
    r = r || {};
    const phone = normalizePhone(r.phone ?? r.customerPhone);
    if (!phone) throw httpError(400, `رقم هاتف الزبون مطلوب${label(i)}`);
    let loc = null;
    if (r.lat !== undefined && r.lat !== null && r.lat !== '') {
      loc = { lat: Number(r.lat), lng: Number(r.lng) };
      if (!isValidPoint(loc)) throw httpError(400, `موقع الزبون غير صالح${label(i)}`);
    }
    let area = null;
    const areaId = r.areaId ?? r.area;
    if (areaId) {
      area = byId.get(String(areaId));
      if (!area) throw httpError(400, `اختر منطقة صحيحة من القائمة${label(i)}`);
    } else if (loc) {
      // بلا منطقة: أقرب منطقة للعرض فقط (التسعير من الموقع نفسه)
      area = areas.filter((a) => isValidPoint(a.center)).sort((x, y) => haversineKm(loc, x.center) - haversineKm(loc, y.center))[0] || null;
    }
    if (!area && !loc) throw httpError(400, `اختر المنطقة أو أضف موقع الزبون${label(i)}`);
    return {
      name: String(r.name ?? r.customerName ?? '').trim().slice(0, 80),
      phone,
      area: area ? area._id : null,
      areaName: area ? area.name : 'موقع محدد',
      areaCenter: area && isValidPoint(area.center) ? { lat: area.center.lat, lng: area.center.lng } : undefined,
      lat: loc ? loc.lat : null,
      lng: loc ? loc.lng : null,
      locationSource: loc ? String(r.source || 'map').slice(0, 10) : '',
      note: String(r.note || '').trim().slice(0, 200),
      status: 'pending',
    };
  });
}

/** طلب سائق من متجر (أو من الكول سنتر باسمه): نقطة تسليم واحدة أو أكثر. */
async function createTripForStore(store, body, source = null) {
  if (!store.location || !isValidPoint(store.location)) throw httpError(400, 'موقع المتجر غير مسجّل');
  const open = await Trip.countDocuments({ store: store._id, status: { $in: ['searching', 'assigned', 'picked'] } });
  if (open >= MAX_OPEN_PER_STORE) throw httpError(409, `لديك ${open} طلبات مفتوحة — الحد ${MAX_OPEN_PER_STORE}`);

  const stops = await buildStops(body || {});
  const storeLocation = { lat: store.location.lat, lng: store.location.lng };
  const { estimateStops } = require('./priceSheet');
  const estimate = estimateStops(storeLocation, stops, await getSettings());
  const first = stops[0];
  const trip = await Trip.create({
    store: store._id,
    storeName: store.name,
    storeLocation,
    area: first.area,
    areaName: stops.length > 1 ? `${first.areaName} +${stops.length - 1}` : first.areaName,
    areaCenter: first.areaCenter,
    stops,
    estimateFils: estimate.estimateFils,
    // نسخة من الزبون الأول للتوافق مع التقارير والفواتير
    customer: { name: first.name, phone: first.phone, lat: first.lat, lng: first.lng },
    status: 'searching',
    requestedAt: new Date(),
    ...(source ? { source } : {}),
  });
  notifyNewTrip(trip);
  const opened = await openNextWave(trip._id);
  return opened || (await Trip.findById(trip._id));
}

/**
 * قبول السائق لعرض. أول قبول يفوز.
 *  1) نحجز مكاناً في قائمة السائق (ذرّياً، بشرط ألا يتجاوز الحد).
 *  2) نقتنص الطلب (ذرّياً، بشرط أنه ما زال يبحث وأن عرض هذا السائق ما زال قائماً).
 *  3) إن فشل الاقتناص نعيد المكان المحجوز — فلا نلمس الطلب أبداً في حالة الفشل.
 */
async function acceptOffer(tripId, driverId) {
  const driver = await Driver.findById(driverId);
  if (!driver || !driver.active) throw httpError(401, 'الحساب غير متاح');
  const tripObjId = new mongoose.Types.ObjectId(String(tripId));
  const max = (await getSettings()).maxConcurrentTrips;

  const reserved = await Driver.findOneAndUpdate(
    { _id: driver._id, active: true, $expr: { $lt: [{ $size: { $ifNull: ['$currentTrips', []] } }, max] } },
    { $push: { currentTrips: tripObjId } },
    { new: true }
  );
  if (!reserved) throw httpError(409, 'وصلت للحد الأقصى من التوصيلات المفتوحة');

  const trip = await Trip.findOneAndUpdate(
    { _id: tripObjId, status: 'searching', offers: { $elemMatch: { driver: driver._id, status: 'sent' } } },
    { $set: { status: 'assigned', driver: driver._id, driverName: driver.name, acceptedAt: new Date(), waveEndsAt: null, 'offers.$.status': 'accepted' } },
    { new: true }
  );
  if (!trip) {
    await Driver.updateOne({ _id: driver._id }, { $pull: { currentTrips: tripObjId } });
    throw httpError(409, 'انتهى هذا العرض أو قبله غيرك');
  }

  const status = reserved.currentTrips.length >= max ? 'busy' : 'available';
  const busy = await Driver.findByIdAndUpdate(driver._id, { $set: { status } }, { new: true });

  const others = trip.offers.filter((o) => o.status === 'sent' && String(o.driver) !== String(driver._id));
  await Trip.updateOne({ _id: trip._id }, { $set: { 'offers.$[o].status': 'cancelled' } }, { arrayFilters: [{ 'o.status': 'sent', 'o.driver': { $ne: driver._id } }] });
  for (const o of others) realtime.toDriver(o.driver, { type: 'offer.closed', tripId: String(trip._id) });
  notifyOfferClosed(others.map((o) => o.driver), trip._id);

  const fresh = await Trip.findById(trip._id);
  publishTrip(fresh);
  publishDriver(busy);
  return fresh;
}

async function declineOffer(tripId, driverId) {
  await Trip.updateOne(
    { _id: tripId, status: 'searching', offers: { $elemMatch: { driver: driverId, status: 'sent' } } },
    { $set: { 'offers.$.status': 'declined' } }
  );
  realtime.toDriver(driverId, { type: 'offer.closed', tripId: String(tripId) });
}

/** يزيل الرحلة من قائمة السائق، ويعيده "متاحاً" إن نزل تحت الحد وكان مشغولاً تلقائياً. */
async function releaseTrip(driverId, tripId) {
  const max = (await getSettings()).maxConcurrentTrips;
  const d = await Driver.findByIdAndUpdate(driverId, { $pull: { currentTrips: tripId } }, { new: true });
  if (d && d.status === 'busy' && d.currentTrips.length < max) {
    return Driver.findByIdAndUpdate(driverId, { $set: { status: 'available' } }, { new: true });
  }
  return d;
}

/** المتجر يؤكد أن السائق استلم الطلب: تبدأ الرحلة وتُثبَّت أسعار الفتح. */
async function confirmPickup(tripId, storeId) {
  const settings = await getSettings();
  const trip = await Trip.findOneAndUpdate(
    { _id: tripId, store: storeId, status: 'assigned' },
    {
      $set: {
        status: 'picked', pickedAt: new Date(),
        pricing: {
          meterFlagFils: settings.meterFlagFils,
          perKmFils: settings.perKmFils,
          companyCutPerKmFils: settings.companyCutPerKmFils,
        },
      },
    },
    { new: true }
  );
  if (!trip) throw httpError(409, 'لا يمكن تأكيد الاستلام في هذه الحالة');
  publishTrip(trip);
  return trip;
}

async function freshDriverPoint(driverId) {
  const driver = await Driver.findById(driverId);
  const fresh = driver && driver.lastLocation && driver.lastLocation.at &&
    Date.now() - new Date(driver.lastLocation.at).getTime() < cfg.locationStaleMs && isValidPoint(driver.lastLocation);
  if (!fresh) throw httpError(409, 'لا يوجد موقع حديث لك — فعّل الموقع ثم حاول مجدداً');
  return { lat: driver.lastLocation.lat, lng: driver.lastLocation.lng };
}

/**
 * السائق يسلّم نقطة (زبوناً) — بأي ترتيب يختاره، وإلى أي مسافة (لا منع للمناطق البعيدة):
 *  • موقع التسليم = GPS السائق لحظة الضغط، ويُحفظ لدى الشركة مع رقم الزبون.
 *  • الكم الهوائي لهذه النقطة = من النقطة السابقة (المتجر للأولى، ثم آخر زبون سُلِّم).
 *  • إن كان للزبون موقع محدد مسبقاً وسُلِّم بعيداً عنه (> deliveryRadiusM) يُعلَّم للمراجعة فقط.
 *  • بعد آخر نقطة: تكتمل الرحلة ويُحسب مجموع الكم وتدخل الأجرة جرد السائق.
 */
async function completeStop(tripId, driverId, stopId) {
  const trip = await Trip.findOne({ _id: tripId, driver: driverId, status: 'picked' });
  if (!trip) throw httpError(409, 'هذه التوصيلة ليست جارية لديك');
  const stop = trip.stops.find((x) => String(x._id) === String(stopId));
  if (!stop) throw httpError(404, 'نقطة التسليم غير موجودة');
  if (stop.status === 'delivered') throw httpError(409, 'سُلِّمت هذه النقطة مسبقاً');

  const point = await freshDriverPoint(driverId);
  const delivered = trip.stops.filter((x) => x.status === 'delivered' && x.deliveredTime)
    .sort((x, y) => new Date(x.deliveredTime) - new Date(y.deliveredTime));
  const prev = delivered.length ? delivered[delivered.length - 1].deliveredAt : trip.storeLocation;
  const legKm = haversineKm(prev, point);
  const known = isValidPoint({ lat: stop.lat, lng: stop.lng });
  const offsetM = known ? Math.round(haversineKm(point, { lat: stop.lat, lng: stop.lng }) * 1000) : null;

  const set = {
    'stops.$[s].status': 'delivered', 'stops.$[s].deliveredAt': point, 'stops.$[s].deliveredTime': new Date(),
    'stops.$[s].legKm': legKm, 'stops.$[s].offsetM': offsetM,
  };
  if (!known) { set['stops.$[s].lat'] = point.lat; set['stops.$[s].lng'] = point.lng; set['stops.$[s].locationSource'] = 'delivery'; }
  // ذرّياً: نقطة معلّقة بعينها فقط (لا يُسلَّم الزبون مرتين لو ضغط السائق مرتين)
  const updated = await Trip.findOneAndUpdate(
    { _id: trip._id, status: 'picked', stops: { $elemMatch: { _id: stop._id, status: 'pending' } } },
    { $set: set }, { new: true, arrayFilters: [{ 's._id': stop._id, 's.status': 'pending' }] }
  );
  if (!updated) throw httpError(409, 'تغيّرت حالة التوصيلة');

  if (updated.stops.some((x) => x.status === 'pending')) { publishTrip(updated); return updated; }

  // آخر نقطة: اكتمال الرحلة والتسعير على مجموع الكم
  const km = Math.round(updated.stops.reduce((sum, x) => sum + (x.legKm || 0), 0) * 100) / 100;
  const pricing = deliveryPricing({
    km,
    meterFlagFils: updated.pricing.meterFlagFils,
    perKmFils: updated.pricing.perKmFils,
    companyCutPerKmFils: updated.pricing.companyCutPerKmFils,
  });
  const first = updated.stops[0];
  const done = await Trip.findOneAndUpdate(
    { _id: updated._id, status: 'picked' },
    { $set: {
      status: 'completed', completedAt: new Date(), km, pricing, deliveredAt: point,
      receiptNo: require('./ledgerService').serial('T'),
      'customer.phone': first.phone, 'customer.lat': first.lat, 'customer.lng': first.lng,
    } },
    { new: true }
  );
  if (!done) throw httpError(409, 'تغيّرت حالة التوصيلة');
  const d = await releaseTrip(driverId, trip._id);
  publishTrip(done);
  if (d) publishDriver(d);
  return done;
}

/** توافق: «تم التسليم» بلا تحديد نقطة يعمل حين تبقى نقطة واحدة فقط. */
async function completeTrip(tripId, driverId) {
  const trip = await Trip.findOne({ _id: tripId, driver: driverId, status: 'picked' });
  if (!trip) throw httpError(409, 'هذه التوصيلة ليست جارية لديك');
  const pending = trip.stops.filter((x) => x.status === 'pending');
  if (pending.length !== 1) throw httpError(400, 'اختر الزبون الذي سلّمته');
  return completeStop(tripId, driverId, pending[0]._id);
}

/**
 * تحديد/تعديل موقع زبون بعد الطلب (رابط مشاركة أو خريطة): المتجر، السائق، أو الإدارة.
 * by: { storeId } | { driverId } | { admin: true }
 */
async function setStopLocation(tripId, stopId, point, by = {}) {
  if (!isValidPoint(point)) throw httpError(400, 'موقع غير صالح');
  const filter = { _id: tripId, status: { $in: ['searching', 'assigned', 'picked'] }, stops: { $elemMatch: { _id: stopId, status: 'pending' } } };
  if (by.storeId) filter.store = by.storeId;
  if (by.driverId) filter.driver = by.driverId;
  const source = by.storeId ? 'store' : by.driverId ? 'driver' : 'admin';
  const sid = new mongoose.Types.ObjectId(String(stopId));
  filter.stops.$elemMatch._id = sid;
  const trip = await Trip.findOneAndUpdate(filter, {
    $set: { 'stops.$[s].lat': point.lat, 'stops.$[s].lng': point.lng, 'stops.$[s].locationSource': source },
  }, { new: true, arrayFilters: [{ 's._id': sid, 's.status': 'pending' }] });
  if (!trip) throw httpError(409, 'لا يمكن تعديل موقع هذا الزبون الآن');
  if (String(trip.stops[0]._id) === String(stopId)) {
    await Trip.updateOne({ _id: trip._id }, { $set: { 'customer.lat': point.lat, 'customer.lng': point.lng } });
  }
  const fresh = await Trip.findById(trip._id);
  publishTrip(fresh);
  return fresh;
}

/**
 * إلغاء: المتجر يلغي وهو يبحث أو قبل الاستلام. الإدارة تلغي قبل التسليم.
 * بعد الاستلام لا يُلغى إلا بقرار الإدارة (تصبح الرحلة ملغاة مع دفع فتحة العداد لو أردت لاحقاً).
 */
async function cancelTrip(tripId, { storeId = null, admin = false } = {}) {
  const allowed = admin ? ['searching', 'assigned', 'picked'] : ['searching', 'assigned'];
  const filter = { _id: tripId, status: { $in: allowed } };
  if (storeId) filter.store = storeId;
  const trip = await Trip.findOneAndUpdate(filter, { $set: { status: 'cancelled', cancelledAt: new Date(), waveEndsAt: null } }, { new: true });
  if (!trip) throw httpError(409, 'لا يمكن إلغاء هذا الطلب في حالته الحالية');

  const openOffers = trip.offers.filter((o) => o.status === 'sent');
  await Trip.updateOne({ _id: trip._id }, { $set: { 'offers.$[o].status': 'cancelled' } }, { arrayFilters: [{ 'o.status': 'sent' }] });
  for (const o of openOffers) realtime.toDriver(o.driver, { type: 'offer.closed', tripId: String(trip._id) });
  notifyOfferClosed(openOffers.map((o) => o.driver), trip._id);

  if (trip.driver) {
    const d = await releaseTrip(trip.driver, trip._id);
    if (d) publishDriver(d);
    // السائق كان في طريقه: إشعار قوي حتى لا يكمل لطلب ملغى
    pushToDrivers([trip.driver], { title: '⛔ أُلغي الطلب', body: `${trip.storeName} ← ${trip.areaName} — لا تكمل إليه`, urgent: true, tag: 'trip-' + trip._id, data: { kind: 'trip.cancelled', link: './?as=driver', tripId: String(trip._id) } })
      .catch((e) => console.error('cancel push:', e.message));
  }
  publishTrip(trip, { cancelledByStore: !!storeId });
  return trip;
}

async function rateDriver(tripId, storeId, stars) {
  const trip = await Trip.findOne({ _id: tripId, store: storeId, status: 'completed', rated: false });
  if (!trip) throw httpError(409, 'لا يمكن تقييم هذه التوصيلة');
  await Rating.create({ store: storeId, driver: trip.driver, trip: trip._id, stars });
  await Trip.updateOne({ _id: trip._id }, { $set: { rated: true } });
  const driver = await Driver.findByIdAndUpdate(trip.driver, { $inc: { ratingSum: stars, ratingCount: 1 } }, { new: true });
  if (driver) { publishDriver(driver); realtime.toDriver(driver._id, { type: 'rated', stars }); }
  publishTrip(await Trip.findById(trip._id));
  return stars;
}

async function sweep(now = new Date()) {
  const due = await Trip.find({ status: 'searching', waveEndsAt: { $lte: now } }).limit(50).lean();
  for (const t of due) {
    const pending = t.offers.filter((o) => o.status === 'sent');
    await Trip.updateOne({ _id: t._id, status: 'searching', wave: t.wave }, { $set: { 'offers.$[o].status': 'expired' } }, { arrayFilters: [{ 'o.status': 'sent' }] });
    for (const o of pending) realtime.toDriver(o.driver, { type: 'offer.closed', tripId: String(t._id) });
    notifyOfferClosed(pending.map((o) => o.driver), t._id);
    await openNextWave(t._id, now).catch((e) => console.error('فشل فتح الموجة:', e.message));
  }
}

let sweeper = null;
let sweeping = false;
function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(async () => {
    if (sweeping) return; // الدورة السابقة لم تنته بعد
    sweeping = true;
    try { await sweep(); } catch (e) { console.error('sweep:', e.message); } finally { sweeping = false; }
  }, SWEEP_MS);
  sweeper.unref();
}
function stopSweeper() { if (sweeper) clearInterval(sweeper); sweeper = null; }

module.exports = {
  pushToStore, pushToDrivers,
  createTripForStore, buildStops, acceptOffer, declineOffer, confirmPickup, completeTrip, completeStop, setStopLocation, cancelTrip,
  rateDriver, sweep, startSweeper, stopSweeper, publishTrip, publishDriver, httpError, releaseTrip, onTripChanged,
  publishDriverEta, onDriverMoved,
};
