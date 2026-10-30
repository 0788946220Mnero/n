/**
 * الجرد المالي — يُحسب من التوصيلات المكتملة فقط (status = completed).
 * الأرقام بالقرش، وكل توصيلة تحمل تفاصيلها: فتحة العداد + الكيلومترات + حصة الشركة.
 */
const mongoose = require('mongoose');
const Trip = require('../models/Trip');

const dateRange = (from, to) => {
  const f = {};
  if (from) f.$gte = new Date(`${from}T00:00:00+03:00`);
  if (to) f.$lt = new Date(new Date(`${to}T00:00:00+03:00`).getTime() + 86400000);
  return Object.keys(f).length ? { completedAt: f } : {};
};

/** جرد السائق نفسه: لا يرى إلا أجرته ولا يرى حصة الشركة. */
async function driverLedger(driverId, { from, to } = {}) {
  const match = { driver: new mongoose.Types.ObjectId(String(driverId)), status: 'completed', ...dateRange(from, to) };
  const [totals, rows] = await Promise.all([
    Trip.aggregate([
      { $match: match },
      { $group: { _id: null, trips: { $sum: 1 }, km: { $sum: '$km' }, driverFils: { $sum: '$pricing.driverFils' } } },
    ]),
    Trip.find(match).sort({ completedAt: -1 }).limit(50).lean(),
  ]);
  const t = totals[0] || { trips: 0, km: 0, driverFils: 0 };
  const acc = await driverAccount(driverId, { from, to });
  return {
    trips: t.trips,
    km: Math.round(t.km * 100) / 100,
    driverFils: t.driverFils,
    // ما على السائق للشركة (النسبة من كل كم) وما دفعه والمتبقي
    companyFils: acc.companyFils, paidFils: acc.paidFils, balanceFils: acc.balanceFils,
    items: rows.map((r) => ({
      id: String(r._id), storeName: r.storeName, areaName: r.areaName,
      km: r.km, driverFils: r.pricing.driverFils, completedAt: r.completedAt,
    })),
  };
}

/** جرد الشركة الكامل لكل سائق: كم توصيلة، كم كم، أجرة السائق، حصة الشركة، ما دفعه المتجر. */
async function adminLedger({ from, to } = {}) {
  const match = { status: 'completed', ...dateRange(from, to) };
  const rows = await Trip.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$driver',
        trips: { $sum: 1 },
        km: { $sum: '$km' },
        driverFils: { $sum: '$pricing.driverFils' },
        companyFils: { $sum: '$pricing.companyFils' },
        storeChargeFils: { $sum: '$pricing.storeChargeFils' },
      },
    },
    { $lookup: { from: 'brq_drivers', localField: '_id', foreignField: '_id', as: 'd' } },
    { $project: { trips: 1, km: 1, driverFils: 1, companyFils: 1, storeChargeFils: 1, driverName: { $arrayElemAt: ['$d.name', 0] } } },
    { $sort: { storeChargeFils: -1 } },
  ]);
  const totals = rows.reduce(
    (a, r) => ({ trips: a.trips + r.trips, km: a.km + r.km, driverFils: a.driverFils + r.driverFils, companyFils: a.companyFils + r.companyFils, storeChargeFils: a.storeChargeFils + r.storeChargeFils }),
    { trips: 0, km: 0, driverFils: 0, companyFils: 0, storeChargeFils: 0 }
  );
  return {
    totals: { ...totals, km: Math.round(totals.km * 100) / 100 },
    byDriver: rows.map((r) => ({
      driverId: r._id ? String(r._id) : null, driverName: r.driverName || '—',
      trips: r.trips, km: Math.round(r.km * 100) / 100,
      driverFils: r.driverFils, companyFils: r.companyFils, storeChargeFils: r.storeChargeFils,
    })),
  };
}

/* ═══════════ الجرد مع التحصيل: ما على السائق للشركة، وكشف المتجر ═══════════ */
const Settlement = require('../models/Settlement');
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const round2 = (n) => Math.round((n || 0) * 100) / 100;
const settleRange = (from, to) => {
  const f = {};
  if (from) f.$gte = new Date(`${from}T00:00:00+03:00`);
  if (to) f.$lt = new Date(new Date(`${to}T00:00:00+03:00`).getTime() + 86400000);
  return Object.keys(f).length ? { createdAt: f } : {};
};
async function sumSettlements(match) {
  const r = await Settlement.aggregate([{ $match: { voided: false, ...match } }, { $group: { _id: null, s: { $sum: '$amountFils' } } }]);
  return r[0] ? r[0].s : 0;
}

/**
 * جرد سائق كامل للإدارة: في الفترة (توصيلات، كم، ما حصّله من المتاجر، أجرته، حصة الشركة عليه، ما دفعه)،
 * والرصيد الكلي المتبقي عليه = كل حصص الشركة − كل ما دفعه (منذ البداية).
 */
async function driverAccount(driverId, { from, to } = {}) {
  const id = oid(driverId);
  const match = { driver: id, status: 'completed', ...dateRange(from, to) };
  const [period, all, list, paidPeriod, paidAll, payments] = await Promise.all([
    Trip.aggregate([{ $match: match }, { $group: { _id: null, trips: { $sum: 1 }, km: { $sum: '$km' }, driverFils: { $sum: '$pricing.driverFils' }, companyFils: { $sum: '$pricing.companyFils' }, storeChargeFils: { $sum: '$pricing.storeChargeFils' } } }]),
    Trip.aggregate([{ $match: { driver: id, status: 'completed' } }, { $group: { _id: null, companyFils: { $sum: '$pricing.companyFils' } } }]),
    Trip.find(match).sort({ completedAt: -1 }).limit(200).lean(),
    sumSettlements({ party: 'driver', driver: id, ...settleRange(from, to) }),
    sumSettlements({ party: 'driver', driver: id }),
    Settlement.find({ party: 'driver', driver: id, voided: false, ...settleRange(from, to) }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  const p = period[0] || { trips: 0, km: 0, driverFils: 0, companyFils: 0, storeChargeFils: 0 };
  const owedAll = all[0] ? all[0].companyFils : 0;
  return {
    trips: p.trips, km: round2(p.km), storeChargeFils: p.storeChargeFils, driverFils: p.driverFils, companyFils: p.companyFils,
    paidFils: paidPeriod, owedAllFils: owedAll, paidAllFils: paidAll, balanceFils: owedAll - paidAll,
    items: list.map((r) => ({
      id: String(r._id), receiptNo: r.receiptNo || '', storeName: r.storeName, areaName: r.areaName, km: r.km,
      storeChargeFils: r.pricing.storeChargeFils, driverFils: r.pricing.driverFils, companyFils: r.pricing.companyFils, completedAt: r.completedAt,
    })),
    payments: payments.map((x) => ({ id: String(x._id), receiptNo: x.receiptNo, amountFils: x.amountFils, note: x.note, byName: x.byName, at: x.createdAt })),
  };
}

/** قائمة السائقين مع الرصيد المتبقي على كل منهم (للتحصيل). */
async function driversBalances({ from, to } = {}) {
  const base = await adminLedger({ from, to });
  const [owed, paid] = await Promise.all([
    Trip.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: '$driver', s: { $sum: '$pricing.companyFils' } } }]),
    Settlement.aggregate([{ $match: { party: 'driver', voided: false } }, { $group: { _id: '$driver', s: { $sum: '$amountFils' } } }]),
  ]);
  const o = new Map(owed.map((r) => [String(r._id), r.s]));
  const pd = new Map(paid.map((r) => [String(r._id), r.s]));
  const Driver = require('../models/Driver');
  const drivers = await Driver.find().select('name phone active').lean();
  const period = new Map(base.byDriver.map((r) => [r.driverId, r]));
  return {
    totals: base.totals,
    drivers: drivers.map((d) => {
      const id = String(d._id); const r = period.get(id) || {};
      return {
        driverId: id, driverName: d.name, phone: d.phone, active: d.active,
        trips: r.trips || 0, km: r.km || 0, storeChargeFils: r.storeChargeFils || 0, driverFils: r.driverFils || 0, companyFils: r.companyFils || 0,
        balanceFils: (o.get(id) || 0) - (pd.get(id) || 0),
      };
    }).sort((a, b) => b.balanceFils - a.balanceFils || b.trips - a.trips),
  };
}

/** كشف المتجر: توصيلاته وما عليه من أجور التوصيل في الفترة، ومدفوعاته للشركة (إن وُجدت). */
async function storeAccount(storeId, { from, to } = {}) {
  const id = oid(storeId);
  const match = { store: id, status: 'completed', ...dateRange(from, to) };
  const [agg, list, paid] = await Promise.all([
    Trip.aggregate([{ $match: match }, { $group: { _id: null, trips: { $sum: 1 }, km: { $sum: '$km' }, storeChargeFils: { $sum: '$pricing.storeChargeFils' } } }]),
    Trip.find(match).sort({ completedAt: -1 }).limit(500).lean(),
    sumSettlements({ party: 'store', store: id, ...settleRange(from, to) }),
  ]);
  const a = agg[0] || { trips: 0, km: 0, storeChargeFils: 0 };
  return {
    trips: a.trips, km: round2(a.km), storeChargeFils: a.storeChargeFils, paidFils: paid,
    items: list.map((r) => ({ id: String(r._id), receiptNo: r.receiptNo || '', areaName: r.areaName, driverName: r.driverName, km: r.km, storeChargeFils: r.pricing.storeChargeFils, completedAt: r.completedAt })),
  };
}

/** كل المتاجر مع مجاميعها في الفترة. */
async function storesTotals({ from, to } = {}) {
  const rows = await Trip.aggregate([
    { $match: { status: 'completed', ...dateRange(from, to) } },
    { $group: { _id: '$store', trips: { $sum: 1 }, km: { $sum: '$km' }, storeChargeFils: { $sum: '$pricing.storeChargeFils' } } },
  ]);
  const Store = require('../models/Store');
  const stores = await Store.find().select('name phone active').lean();
  const m = new Map(rows.map((r) => [String(r._id), r]));
  return stores.map((s) => {
    const r = m.get(String(s._id)) || {};
    return { storeId: String(s._id), name: s.name, phone: s.phone, active: s.active, trips: r.trips || 0, km: round2(r.km), storeChargeFils: r.storeChargeFils || 0 };
  }).sort((a, b) => b.storeChargeFils - a.storeChargeFils);
}

/** رقم سند/وصل متسلسل بالتاريخ: R-20261030-4F2A */
const serial = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

module.exports = { driverLedger, adminLedger, driverAccount, driversBalances, storeAccount, storesTotals, serial };
