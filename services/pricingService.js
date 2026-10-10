/*
  ═══════════════════════════════════════════════════════════════
  تسعير أصناف الطلب — الخادم مصدر الحقيقة.

  القاعدة: لا يُقبل من الجهاز إلا «ماذا» يريد الزبون (رقم المنتج، الكمية،
  أسماء الإضافات، الملاحظة). أما «بكم» فمن قاعدة البيانات فقط:
    • صنف بلا رقم منتج صالح، أو منتج غير موجود ← يُرفض الطلب.
    • صنف موقوف (isAvailable=false) ← يُرفض الطلب.
    • الإضافة غير المعرّفة على المنتج ← تُحذف (لا سعر من الجهاز).
    • الكمية عدد صحيح بين 1 و maxQty.
    • اسم الصنف وطابعته من المنتج، لا من الجهاز.

  ترجع: { items, itemsTotal } أو { error, code, names }.
  أخطاء قاعدة البيانات لا تُبتلع هنا — تصعد لمعالجها فيفشل الطلب بدل أن
  يُسعَّر بأسعار الجهاز.
  ═══════════════════════════════════════════════════════════════
*/
const mongoose = require('mongoose');
const Product = require('../models/Product');

const round3 = (n) => Number(Number(n || 0).toFixed(3));
const clampQty = (raw, maxQty) => Math.min(maxQty, Math.max(1, parseInt(raw, 10) || 1));

const priceOrderItems = async (rawItems, { maxQty = 999, maxNoteLength = 300 } = {}) => {
  const lines = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
  if (!lines.length) return { error: 'لا توجد أصناف في الطلب', code: 'NO_ITEMS' };

  const validIds = lines
    .map((l) => l.product)
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
  const products = validIds.length
    ? await Product.find({ _id: { $in: validIds } }).select('nameAr price addons isAvailable printerName').lean()
    : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const missing = [];
  const unavailable = [];
  const items = [];

  for (const line of lines) {
    const p = line.product && mongoose.Types.ObjectId.isValid(line.product) ? byId.get(String(line.product)) : null;
    if (!p || typeof p.price !== 'number') {
      missing.push(String(line.nameAr || line.name || 'صنف').slice(0, 60));
      continue;
    }
    if (p.isAvailable === false) {
      unavailable.push(p.nameAr);
      continue;
    }

    const known = new Map((p.addons || []).map((a) => [String(a.name || '').trim(), Number(a.price || 0)]));
    const picked = new Set();
    const addons = (Array.isArray(line.addons) ? line.addons : [])
      .map((a) => String((a && a.name) || '').trim())
      .filter((n) => known.has(n) && !picked.has(n) && picked.add(n))
      .map((n) => ({ name: n, price: known.get(n) }));

    items.push({
      product: p._id,
      nameAr: p.nameAr,
      quantity: clampQty(line.quantity || line.qty, maxQty),
      price: round3(p.price + addons.reduce((t, a) => t + a.price, 0)),
      addons,
      notes: String(line.notes || '').slice(0, maxNoteLength),
      printerName: p.printerName || '',
    });
  }

  if (unavailable.length) {
    return {
      error: `عذراً، أصبح غير متوفر حالياً: ${unavailable.join('، ')}. الرجاء تعديل طلبك.`,
      code: 'ITEM_UNAVAILABLE',
      names: unavailable,
    };
  }
  if (missing.length) {
    return {
      error: `بعض الأصناف لم تعد موجودة في القائمة: ${missing.join('، ')}. الرجاء حذفها من السلة وإعادة إضافتها.`,
      code: 'ITEM_NOT_FOUND',
      names: missing,
    };
  }

  return { items, itemsTotal: round3(items.reduce((t, i) => t + i.price * i.quantity, 0)) };
};

module.exports = { priceOrderItems, round3 };
