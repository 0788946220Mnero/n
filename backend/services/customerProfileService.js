/**
 * ملف الزبون في الدردشة: الاسم والصورة وعدد الطلبات المكتملة ← «الإطار» حول صورته.
 *   0 طلب: زبون جديد · 1+: برونزي · 5+: فضي · 15+: ذهبي · 30+: ماسي
 * عدد الطلبات من الطلبات المكتملة (delivered) برقمه بكل صيغه، مخبّأ 10 دقائق.
 */
const CustomerProfile = require('../models/CustomerProfile');
const { phoneVariantsJo } = require('../utils/phone');

const TIERS = [
  { key: 'new', min: 0, label: 'زبون جديد', labelEn: 'New' },
  { key: 'bronze', min: 1, label: 'برونزي', labelEn: 'Bronze' },
  { key: 'silver', min: 5, label: 'فضي', labelEn: 'Silver' },
  { key: 'gold', min: 15, label: 'ذهبي', labelEn: 'Gold' },
  { key: 'diamond', min: 30, label: 'ماسي', labelEn: 'Diamond' },
];
const COUNT_TTL = 10 * 60 * 1000;

function tierOf(count) {
  const n = Math.max(0, Number(count) || 0);
  let i = 0;
  TIERS.forEach((t, idx) => { if (n >= t.min) i = idx; });
  const t = TIERS[i]; const next = TIERS[i + 1] || null;
  return { key: t.key, label: t.label, labelEn: t.labelEn, next: next ? { key: next.key, label: next.label, labelEn: next.labelEn, remaining: next.min - n } : null };
}

const avatarUrl = (p) => (p && p.avatar ? `/api/community/avatar/${p.avatar}` : '');

/** ما يراه الآخرون عن الزبون — بلا رقم هاتف ولا معرّف حساب. */
function publicAuthor(p) {
  if (!p) return { name: 'زبون', avatar: '', orderCount: 0, tier: tierOf(0) };
  return { id: String(p._id), name: p.displayName || 'زبون', avatar: avatarUrl(p), orderCount: p.orderCount || 0, tier: tierOf(p.orderCount) };
}

async function countOrders(phone) {
  const Order = require('../models/Order');
  const variants = phoneVariantsJo(phone);
  if (!variants.length) return 0;
  return Order.countDocuments({ phone: { $in: variants }, status: 'delivered' });
}

/** ملف الزبون (يُنشأ عند أول استخدام). */
async function forPhoneUser(phoneUser) {
  let p = await CustomerProfile.findOne({ phoneUser: phoneUser._id });
  if (!p) {
    try { p = await CustomerProfile.create({ phoneUser: phoneUser._id, phone: phoneUser.phone }); } catch (e) {
      if (e && e.code === 11000) p = await CustomerProfile.findOne({ phoneUser: phoneUser._id }); else throw e;
    }
  }
  return p;
}

/** يحدّث عدد الطلبات إن قدُم (أو force). */
async function refreshOrderCount(p, force) {
  if (!p) return p;
  if (!force && p.orderCountAt && Date.now() - new Date(p.orderCountAt).getTime() < COUNT_TTL) return p;
  try {
    const n = await countOrders(p.phone);
    await CustomerProfile.updateOne({ _id: p._id }, { $set: { orderCount: n, orderCountAt: new Date() } });
    p.orderCount = n; p.orderCountAt = new Date();
  } catch (e) { console.error('order count:', e.message); }
  return p;
}

/** هل الزبون محظور من الكتابة في الدردشة العامة الآن؟ (الحظر المؤقت ينتهي وحده) */
function banState(p) {
  const b = (p && p.communityBan) || {};
  if (!b.banned) return null;
  if (b.until && new Date(b.until).getTime() <= Date.now()) return null;
  return { until: b.until || null, reason: b.reason || '' };
}

module.exports = { TIERS, tierOf, avatarUrl, publicAuthor, countOrders, forPhoneUser, refreshOrderCount, banState };
