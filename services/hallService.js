/**
 * الصالة: طاولات، وحسابات مفتوحة تُضاف إليها جولات من التابلت/الجوال.
 *
 *   جولة جديدة  ← أسعارها من قاعدة البيانات ← مهمة طباعة «hall» لأقسام المطبخ
 *                  (محطة الطباعة داخل المطعم تحجزها ذرّياً وتطبعها على طابعات الأقسام عبر الشبكة)
 *   طلب الحساب ← مهمة «hallbill» على الطابعة الرئيسية (كشف حساب، ليس فاتورة نهائية)
 *   الدفع       ← طلب واحد (Order, source:'hall', orderType:'dinein') يدخل جرد من قبض المال
 *
 * حتى الدفع لا يدخل الحساب أي جرد ولا إحصائيات.
 */
const mongoose = require('mongoose');
const HallTable = require('../models/HallTable');
const HallTab = require('../models/HallTab');
const Product = require('../models/Product');
const Order = require('../models/Order');
const PrintJob = require('../models/PrintJob');
const realtime = require('./realtimeService');
const { allocateOrderNumber } = require('../utils/orderNumber');

const JOB_TTL_MS = 10 * 60 * 1000; // طلبات المطبخ: مهلة أطول من الطباعة العادية
const nameOf = (u) => (u && (u.name || u.username)) || '';
const httpError = (status, message) => Object.assign(new Error(message), { status });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const money = (n) => Math.round(Number(n || 0) * 1000) / 1000;

function tabTotal(tab) {
  return money((tab.items || []).filter((i) => !i.voided).reduce((s, i) => s + i.price * i.quantity, 0));
}

function publicTab(tab) {
  if (!tab) return null;
  const t = typeof tab.toObject === 'function' ? tab.toObject() : tab;
  return {
    id: String(t._id), table: String(t.table), tableName: t.tableName, zone: t.zone, guests: t.guests || 0,
    status: t.status, rounds: t.rounds || 0, notes: t.notes || '', waiterName: t.waiterName || '',
    openedAt: t.createdAt, billRequestedAt: t.billRequestedAt || null, total: tabTotal(t),
    items: (t.items || []).map((i) => ({
      id: String(i._id), product: i.product ? String(i.product) : '', nameAr: i.nameAr, price: i.price, quantity: i.quantity,
      addons: i.addons || [], notes: i.notes || '', round: i.round, addedByName: i.addedByName || '', addedAt: i.addedAt,
      voided: !!i.voided, voidedByName: i.voidedByName || '', voidReason: i.voidReason || '',
    })),
    order: t.order ? String(t.order) : null,
  };
}

function publicTable(table, tab) {
  return {
    id: String(table._id), name: table.name, zone: table.zone || '', seats: table.seats, sort: table.sort || 0, active: table.active !== false,
    tab: tab ? {
      id: String(tab._id), guests: tab.guests || 0, total: tabTotal(tab), rounds: tab.rounds || 0, waiterName: tab.waiterName || '',
      openedAt: tab.createdAt, billRequestedAt: tab.billRequestedAt || null,
      items: (tab.items || []).filter((i) => !i.voided).reduce((s, i) => s + i.quantity, 0),
    } : null,
  };
}

/** بث لكل أجهزة الصالة (والكاشير): تغيّر طاولة أو حسابها. */
async function publish(tableId) {
  try {
    const table = await HallTable.findById(tableId).lean();
    if (!table) return;
    const tab = table.tab ? await HallTab.findById(table.tab).lean() : null;
    realtime.broadcast('hall.table', { table: publicTable(table, tab && tab.status === 'open' ? tab : null) });
  } catch (_) { /* البث لا يعطّل العملية */ }
}

/* ═══ الطاولات ═══ */
async function listTables({ all = false } = {}) {
  const tables = await HallTable.find(all ? {} : { active: true }).sort({ sort: 1, name: 1 }).lean();
  const ids = tables.map((t) => t.tab).filter(Boolean);
  const tabs = ids.length ? await HallTab.find({ _id: { $in: ids }, status: 'open' }).lean() : [];
  const byId = new Map(tabs.map((t) => [String(t._id), t]));
  return tables.map((t) => publicTable(t, t.tab ? byId.get(String(t.tab)) : null));
}

function cleanTable(body) {
  const out = {};
  if (body.name !== undefined) {
    out.name = String(body.name || '').trim().slice(0, 40);
    if (!out.name) throw httpError(400, 'اكتب اسم الطاولة أو رقمها');
  }
  if (body.zone !== undefined) out.zone = String(body.zone || '').trim().slice(0, 40);
  if (body.seats !== undefined) out.seats = Math.min(60, Math.max(1, parseInt(body.seats, 10) || 4));
  if (body.sort !== undefined) out.sort = parseInt(body.sort, 10) || 0;
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

async function createTable(body) {
  const data = cleanTable({ seats: 4, ...body, name: body.name });
  if (await HallTable.exists({ name: data.name, zone: data.zone || '' })) throw httpError(409, 'توجد طاولة بهذا الاسم في القسم نفسه');
  const t = await HallTable.create(data);
  publish(t._id);
  return publicTable(t.toObject(), null);
}

/** إنشاء عدة طاولات دفعة واحدة: «1-12» في قسم. */
async function createRange({ from, to, zone, seats, prefix = '' }) {
  const a = parseInt(from, 10); const b = parseInt(to, 10);
  if (!(a >= 1 && b >= a && b - a < 100)) throw httpError(400, 'المدى غير صحيح (حتى 100 طاولة في المرة)');
  const made = [];
  for (let n = a; n <= b; n++) {
    const name = `${String(prefix || '').trim()}${n}`;
    if (await HallTable.exists({ name, zone: String(zone || '').trim() })) continue;
    made.push(await HallTable.create(cleanTable({ name, zone, seats: seats || 4, sort: n })));
  }
  return made.length;
}

async function updateTable(id, body) {
  if (!isId(id)) throw httpError(400, 'طاولة غير صالحة');
  const t = await HallTable.findByIdAndUpdate(id, { $set: cleanTable(body) }, { new: true });
  if (!t) throw httpError(404, 'الطاولة غير موجودة');
  publish(t._id);
  return t;
}

async function deleteTable(id) {
  if (!isId(id)) throw httpError(400, 'طاولة غير صالحة');
  const t = await HallTable.findOneAndDelete({ _id: id, tab: null });
  if (!t) throw httpError(409, 'لا يمكن حذف طاولة عليها حساب مفتوح');
  realtime.broadcast('hall.removed', { tableId: String(id) });
}

/* ═══ الحسابات ═══ */
async function getTab(id) {
  if (!isId(id)) throw httpError(400, 'حساب غير صالح');
  const tab = await HallTab.findById(id);
  if (!tab) throw httpError(404, 'الحساب غير موجود');
  return tab;
}

/** الأصناف بأسعار قاعدة البيانات وتوجيه طابعات الأقسام (نفس منطق البيع المباشر). */
async function priceItems(items, user, round) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, 'لا توجد أصناف في الطلب');
  if (items.length > 60) throw httpError(400, 'أصناف كثيرة في جولة واحدة');
  const ids = items.map((i) => i.product).filter(isId);
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const out = [];
  for (const item of items) {
    const p = byId.get(String(item.product));
    if (!p) throw httpError(400, `صنف غير موجود: ${item.nameAr || item.product}`);
    if (p.isAvailable === false || p.isActive === false) throw httpError(400, `الصنف غير متوفر الآن: ${p.nameAr || p.name}`);
    const quantity = Math.min(99, Math.max(1, parseInt(item.quantity, 10) || 1));
    const addons = Array.isArray(item.addons) ? item.addons.map((a) => {
      const known = (p.addons || []).find((x) => x.name === (a && a.name));
      return known ? { name: known.name, price: Number(known.price) || 0 } : null;
    }).filter(Boolean) : [];
    out.push({
      product: p._id, nameAr: p.nameAr || p.name, price: money(Number(p.price) + addons.reduce((s, a) => s + a.price, 0)),
      quantity, addons, notes: String(item.notes || '').slice(0, 200), printerName: '',
      round, addedByName: nameOf(user), addedAt: new Date(),
    });
  }
  try {
    const groups = await require('./printerService').groupOrderItemsByPrinter(out);
    for (const g of groups) for (const it of g.items) it.printerName = g.printer ? g.printer.name : '';
  } catch (_) { /* التوجيه تحسمه محطة الطباعة أيضاً */ }
  return out;
}

function kitchenJob(tab, items, user, { round, voided = false } = {}) {
  return PrintJob.create({
    type: 'hall',
    payload: {
      tabId: String(tab._id), tableName: tab.tableName, zone: tab.zone, guests: tab.guests || 0, round, voided,
      waiterName: nameOf(user), notes: voided ? '' : tab.notes || '',
      items: items.map((i) => ({ product: String(i.product || ''), nameAr: i.nameAr, quantity: i.quantity, addons: i.addons || [], notes: i.notes || '', printerName: i.printerName || '', price: i.price })),
    },
    requestedBy: user && user._id, requestedByName: nameOf(user),
    expiresAt: new Date(Date.now() + JOB_TTL_MS),
  });
}

/**
 * جولة طلبات لطاولة: تفتح حساباً إن كانت فارغة (ذرّياً — جهازان على الطاولة نفسها لا يفتحان حسابين)،
 * وتطبع الجولة وحدها على أقسام المطبخ.
 */
async function addRound(tableId, body, user) {
  if (!isId(tableId)) throw httpError(400, 'طاولة غير صالحة');
  const table = await HallTable.findById(tableId);
  if (!table || table.active === false) throw httpError(404, 'الطاولة غير موجودة');
  const clientRef = String(body.clientRef || '').slice(0, 64);

  let tab = table.tab ? await HallTab.findOne({ _id: table.tab, status: 'open' }) : null;
  if (clientRef && tab && tab.clientRefs.includes(clientRef)) return { tab, job: null, duplicate: true };

  if (!tab) {
    const fresh = await HallTab.create({
      table: table._id, tableName: table.name, zone: table.zone || '', guests: Math.max(0, parseInt(body.guests, 10) || 0),
      waiter: user && user._id, waiterName: nameOf(user), notes: String(body.notes || '').slice(0, 300),
    });
    const claimed = await HallTable.findOneAndUpdate({ _id: table._id, $or: [{ tab: null }, { tab: { $exists: false } }] }, { $set: { tab: fresh._id } }, { new: true });
    if (claimed) tab = fresh;
    else {
      await HallTab.deleteOne({ _id: fresh._id });
      const cur = await HallTable.findById(table._id);
      tab = cur && cur.tab ? await HallTab.findOne({ _id: cur.tab, status: 'open' }) : null;
      if (!tab) throw httpError(409, 'تغيّرت حالة الطاولة — حاول مجدداً');
    }
  }

  const round = (tab.rounds || 0) + 1;
  const items = await priceItems(body.items, user, round);
  const set = { rounds: round };
  if (body.guests !== undefined && parseInt(body.guests, 10) > 0) set.guests = parseInt(body.guests, 10);
  if (body.notes) set.notes = String(body.notes).slice(0, 300);
  const updated = await HallTab.findOneAndUpdate(
    { _id: tab._id, status: 'open', rounds: tab.rounds || 0, ...(clientRef ? { clientRefs: { $ne: clientRef } } : {}) },
    { $push: { items: { $each: items }, ...(clientRef ? { clientRefs: { $each: [clientRef], $slice: -50 } } : {}) }, $set: set },
    { new: true }
  );
  if (!updated) {
    const again = await HallTab.findById(tab._id);
    if (clientRef && again && again.clientRefs.includes(clientRef)) return { tab: again, job: null, duplicate: true };
    throw httpError(409, 'أُضيفت جولة أخرى للطاولة في اللحظة نفسها — حدّث الصفحة وأعد الإرسال');
  }
  const job = await kitchenJob(updated, items, user, { round });
  try { realtime.emitPrintJob(job); } catch (_) {}
  publish(table._id);
  return { tab: updated, job };
}

async function requestBill(tabId, user) {
  const tab = await getTab(tabId);
  if (tab.status !== 'open') throw httpError(409, 'الحساب مغلق');
  if (!tab.items.some((i) => !i.voided)) throw httpError(400, 'لا أصناف على الطاولة بعد');
  tab.billRequestedAt = new Date();
  await tab.save();
  const job = await PrintJob.create({
    type: 'hallbill',
    payload: { tab: publicTab(tab), requestedByName: nameOf(user) },
    requestedBy: user && user._id, requestedByName: nameOf(user),
    expiresAt: new Date(Date.now() + JOB_TTL_MS),
  });
  try { realtime.emitPrintJob(job); } catch (_) {}
  publish(tab.table);
  return { tab, job };
}

async function voidItem(tabId, itemId, reason, user) {
  const tab = await getTab(tabId);
  if (tab.status !== 'open') throw httpError(409, 'الحساب مغلق');
  const it = tab.items.id(itemId);
  if (!it || it.voided) throw httpError(404, 'الصنف غير موجود أو أُلغي');
  it.voided = true; it.voidedByName = nameOf(user); it.voidReason = String(reason || '').slice(0, 120);
  await tab.save();
  // المطبخ يُبلَّغ بالإلغاء على قسم الصنف نفسه
  const job = await kitchenJob(tab, [it], user, { round: it.round, voided: true });
  try { realtime.emitPrintJob(job); } catch (_) {}
  publish(tab.table);
  return tab;
}

async function moveTab(tabId, toTableId, user) {
  const tab = await getTab(tabId);
  if (tab.status !== 'open') throw httpError(409, 'الحساب مغلق');
  if (!isId(toTableId) || String(toTableId) === String(tab.table)) throw httpError(400, 'اختر طاولة أخرى');
  const to = await HallTable.findOneAndUpdate({ _id: toTableId, active: true, tab: null }, { $set: { tab: tab._id } }, { new: true });
  if (!to) throw httpError(409, 'الطاولة المطلوبة مشغولة أو غير موجودة');
  const from = tab.table;
  await HallTable.updateOne({ _id: from, tab: tab._id }, { $set: { tab: null } });
  tab.table = to._id; tab.tableName = to.name; tab.zone = to.zone || '';
  await tab.save();
  publish(from); publish(to._id);
  return tab;
}

/** القبض والإغلاق: طلب واحد يدخل جرد من قبض المال. */
async function payTab(tabId, body, user) {
  const tab = await getTab(tabId);
  if (tab.status !== 'open') throw httpError(409, 'أُغلق هذا الحساب مسبقاً');
  const items = tab.items.filter((i) => !i.voided);
  if (!items.length) throw httpError(400, 'لا أصناف على الطاولة — استعمل «إلغاء الحساب»');
  // ذرّياً: جهازان لا يقبضان الحساب نفسه مرتين
  const locked = await HallTab.findOneAndUpdate({ _id: tab._id, status: 'open' }, { $set: { status: 'paid', closedAt: new Date(), closedByName: nameOf(user) } }, { new: true });
  if (!locked) throw httpError(409, 'أُغلق هذا الحساب من جهاز آخر');
  const itemsTotal = money(items.reduce((s, i) => s + i.price * i.quantity, 0));
  const discount = Math.min(itemsTotal, Math.max(0, money(body.discount)));
  let order;
  try {
    order = await Order.create({
      ...(await allocateOrderNumber('hall')),
      customerName: `طاولة ${tab.tableName}`, phone: '', address: '',
      items: items.map((i) => ({ product: i.product, nameAr: i.nameAr, price: i.price, quantity: i.quantity, addons: i.addons, notes: i.notes, printerName: i.printerName })),
      itemsTotal, discount, deliveryFee: 0, total: money(itemsTotal - discount),
      paymentMethod: ['cash', 'cliq', 'card'].includes(body.paymentMethod) ? body.paymentMethod : 'cash',
      orderType: 'dinein', source: 'hall', tableName: tab.tableName, hallTab: tab._id,
      notes: [tab.notes, tab.guests ? `${tab.guests} أشخاص` : '', tab.waiterName ? `النادل: ${tab.waiterName}` : ''].filter(Boolean).join(' · '),
      status: 'delivered', confirmedAt: new Date(), deliveredAt: new Date(),
      // قسائم المطبخ طُبعت جولةً جولة — لا تُعاد عند الإغلاق
      ticketsAt: new Date(), ticketsBy: 'الصالة',
      handledBy: user._id, handledByName: nameOf(user),
      timeline: [{ event: 'status:delivered', at: new Date(), byName: nameOf(user) }],
    });
  } catch (e) {
    await HallTab.updateOne({ _id: tab._id }, { $set: { status: 'open', closedAt: null, closedByName: '' } });
    throw e;
  }
  await HallTab.updateOne({ _id: tab._id }, { $set: { order: order._id } });
  await HallTable.updateOne({ _id: tab.table, tab: tab._id }, { $set: { tab: null } });
  try { realtime.emitOrderCreated(order); } catch (_) {}
  try { require('../utils/activity').logActivity({ user, action: 'hall.pay', order, details: { table: tab.tableName, total: order.total } }); } catch (_) {}
  publish(tab.table);
  return { order, tab: locked };
}

/** إلغاء حساب بلا أصناف (أو بأصناف ملغاة كلها) — يُفرغ الطاولة. */
async function voidTab(tabId, user) {
  const tab = await getTab(tabId);
  if (tab.status !== 'open') throw httpError(409, 'الحساب مغلق');
  if (tab.items.some((i) => !i.voided)) throw httpError(409, 'على الطاولة أصناف — ألغِها أولاً أو اقبض الحساب');
  await HallTab.updateOne({ _id: tab._id, status: 'open' }, { $set: { status: 'void', closedAt: new Date(), closedByName: nameOf(user) } });
  await HallTable.updateOne({ _id: tab.table, tab: tab._id }, { $set: { tab: null } });
  publish(tab.table);
}

module.exports = {
  listTables, createTable, createRange, updateTable, deleteTable,
  getTab, addRound, requestBill, voidItem, moveTab, payTab, voidTab,
  publicTab, publicTable, tabTotal,
};
