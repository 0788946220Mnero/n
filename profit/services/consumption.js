/**
 * ترحيل تكلفة المبيعات واستهلاك المخزون — منفصل عن مسارات إنشاء الطلب كلها
 * (سفري، منصة، سنتر، صالة، تطبيق)، فلا يُبطئ البيع ولا يُفشله:
 *   • يمرّ كل دقيقة على الطلبات المؤكَّدة غير المرحَّلة (من تاريخ تفعيل النظام فقط)
 *   • لكل سطر: لقطة تكلفة SaleCost بنسخة الوصفة السارية وقت البيع ومتوسط التكلفة لحظتها،
 *     وحركات خصم sale لكل مكوّن — كلها بمفاتيح فريدة، فالإعادة لا تخصم مرتين
 *   • الطلب الملغى بعد ترحيله ← حركات عكسية sale_reversal ولقطته تُعلَّم reversed
 */
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const SaleCost = require('../models/SaleCost');
const { costLine, makeCtx, r6 } = require('./costing');
const ledger = require('./ledger');
const { businessDay } = require('./time');
const { getConfig } = require('./config');

const NOT_SALES = ['pending', 'cancelled'];
const channelOf = (o) => (o.source === 'web' || o.source === 'app' ? `${o.source}-${o.orderType || 'delivery'}` : o.source || 'pos');
const saleAt = (o) => o.offlineSoldAt || o.createdAt;

/** يرحّل طلباً واحداً — آمن للتكرار والتزامن. */
async function postOrder(order, cfg) {
  cfg = cfg || await getConfig();
  if (NOT_SALES.includes(order.status)) return { skipped: 'status' };
  const at = new Date(saleAt(order));
  if (!cfg.startedAt || at < new Date(cfg.startedAt)) return { skipped: 'before-start' };
  const day = businessDay(at, cfg.dayStartHour);
  const ctx = makeCtx();
  const items = order.items || [];
  const itemsTotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
  const discount = Number(order.discount) || 0;
  const pids = items.map((i) => i.product).filter(Boolean);
  const cats = new Map((await Product.find({ _id: { $in: pids } }).select('category').lean()).map((p) => [String(p._id), p.category]));
  let posted = 0;

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const key = `sale:${order._id}:${i}`;
    if (await SaleCost.exists({ key })) continue;
    const qty = Number(it.quantity) || 1;
    const revenue = r6((Number(it.price) || 0) * qty);
    const c = it.product
      ? await costLine({ product: it.product, qty, addons: it.addons || [], at, ctx })
      : { recipe: null, components: [], material: 0, packaging: 0, cost: 0, missingRecipe: true, missingCost: false };

    // الحركات أولاً (بمفاتيحها) ثم اللقطة: انقطاع بينهما لا يترك خصماً بلا لقطة أو العكس عند الإعادة
    for (let k = 0; k < c.components.length; k += 1) {
      const comp = c.components[k];
      await ledger.post({
        key: `${key}:${k}`, ingredient: comp.deductFrom, ingredientName: comp.name, type: 'sale',
        qty: -comp.qty, unitCost: comp.unitCost, at, businessDay: day, refType: 'order', refId: String(order._id),
        reason: `#${order.orderNumber || ''} ${it.nameAr || ''}${comp.addon ? ` (+${comp.addon})` : ''}`,
      });
    }
    try {
      await SaleCost.create({
        key, kind: 'sale', order: order._id, orderNumber: String(order.orderNumber || ''), lineIndex: i,
        product: it.product || null, productName: it.nameAr || '', category: cats.get(String(it.product)) || null,
        channel: channelOf(order), qty, revenue,
        discountShare: itemsTotal > 0 ? r6((discount * revenue) / itemsTotal) : 0,
        recipe: c.recipe ? c.recipe._id : null, recipeVersion: c.recipe ? c.recipe.version : null,
        material: c.material, packaging: c.packaging, cost: c.cost,
        missingRecipe: c.missingRecipe, missingCost: !!c.missingCost,
        components: c.components.map(({ deductFrom, ...x }) => x),
        at, businessDay: day, shiftId: order.shiftId || '',
      });
      posted += 1;
    } catch (e) { if (!(e && e.code === 11000)) throw e; }
  }
  await Order.updateOne({ _id: order._id }, { $set: { costPosted: true, costPostedAt: new Date() } });
  return { posted };
}

/** عكس طلب أُلغي بعد ترحيله: يعيد المكوّنات للمخزون ويعلّم لقطاته. */
async function reverseOrder(order) {
  const rows = await SaleCost.find({ order: order._id, kind: 'sale', reversed: { $ne: true } }).lean();
  const now = new Date(); const cfg = await getConfig();
  for (const sc of rows) {
    for (let k = 0; k < (sc.components || []).length; k += 1) {
      const comp = sc.components[k];
      await ledger.post({
        key: `rev:${sc.key}:${k}`, ingredient: comp.ingredient, ingredientName: comp.name, type: 'sale_reversal',
        qty: comp.qty, unitCost: comp.unitCost, at: now, businessDay: businessDay(now, cfg.dayStartHour),
        refType: 'order', refId: String(order._id), reason: `إلغاء #${order.orderNumber || ''}`,
      });
    }
    await SaleCost.updateOne({ _id: sc._id }, { $set: { reversed: true, reversedAt: now } });
  }
  await Order.updateOne({ _id: order._id }, { $set: { costReversed: true } });
  return { reversed: rows.length };
}

let running = false;
/** دورة واحدة: ترحيل الجديد وعكس الملغى. ترجع ما تم. */
async function runOnce(limit = 300) {
  if (running) return { busy: true };
  running = true;
  try {
    const cfg = await getConfig(true);
    if (!cfg.enabled || !cfg.startedAt) return { disabled: true };
    const pending = await Order.find({ costPosted: { $ne: true }, status: { $nin: NOT_SALES }, createdAt: { $gte: new Date(new Date(cfg.startedAt).getTime() - 7 * 864e5) } })
      .sort({ createdAt: 1 }).limit(limit).lean();
    let posted = 0;
    for (const o of pending) { const r = await postOrder(o, cfg); posted += r.posted || 0; if (r.skipped === 'before-start') await Order.updateOne({ _id: o._id }, { $set: { costPosted: true } }); }
    const cancelled = await Order.find({ status: 'cancelled', costPosted: true, costReversed: { $ne: true } }).limit(limit).lean();
    let reversed = 0;
    for (const o of cancelled) reversed += (await reverseOrder(o)).reversed;
    return { orders: pending.length, posted, reversed };
  } finally { running = false; }
}

let timer = null;
function start() {
  if (timer) return;
  const tick = () => runOnce().catch((e) => console.error('profit consumption:', e.message));
  const mongoose = require('mongoose');
  const go = () => { tick(); timer = setInterval(tick, 60000); if (timer.unref) timer.unref(); };
  if (mongoose.connection.readyState === 1) go(); else mongoose.connection.once('open', go);
}

module.exports = { postOrder, reverseOrder, runOnce, start, channelOf };
