const crypto = require('crypto');
const mongoose = require('mongoose');
const { wrapAll } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activity');
const Offer = require('../models/Offer');
const Product = require('../models/Product');
const Category = require('../models/Category');

/*
  ═══════════════════════════════════════════════════════════════
  العروض الترويجية — روابط خارجية بمعاينة (صورة/فيديو) تفتح صنفاً أو تصنيفاً بخصم ثابت.

  الإدارة (offers:manage):
    GET    /api/offers                 القائمة مع اسم الهدف والمشاهدات والطلبات
    POST   /api/offers                 إنشاء (multipart: media صورة أو فيديو، cover غلاف اختياري)
    PUT    /api/offers/:id             تعديل (removeMedia=1 / removeCover=1 للحذف)
    DELETE /api/offers/:id             حذف
  عام (بلا دخول):
    GET    /api/offers/public/:code    بيانات العرض الفعّال للموقع
    GET    /o/:code                    صفحة المشاركة: وسوم og لفيسبوك وواتساب، والزبون يُحوَّل للعرض
  ═══════════════════════════════════════════════════════════════
*/

/** الموقع العام (Netlify) — منه تُنسخ الروابط وإليه يُحوَّل الزبون. */
const siteUrl = () => String(process.env.PUBLIC_SITE_URL || 'https://diyaralanbat.com').replace(/\/$/, '');
const round3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const bad = (res, status, message) => res.status(status).json({ success: false, message });
const fileOf = (req, name) => (req.files && req.files[name] && req.files[name][0]) || (name === 'media' && req.file) || null;
const isVideoFile = (f) => /^video\//i.test(f.mimetype || '') || /\.(mp4|webm|mov)$/i.test(f.originalname || '');

async function newCode() {
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(5).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase();
    if (code.length === 6 && !(await Offer.exists({ code }))) return code;
  }
  return crypto.randomBytes(6).toString('hex');
}

const parseDate = (v) => { if (v === undefined || v === null || v === '') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; };

/** يقرأ حقول النموذج (JSON أو multipart نصي) ويتحقق منها. يرجع { data } أو { error }. */
async function readForm(body, existing) {
  const b = body || {};
  const data = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!existing || has('title')) {
    data.title = String(b.title || '').trim().slice(0, 120);
    if (!data.title) return { error: 'اكتب عنوان العرض — يظهر في المنشور' };
  }
  if (!existing || has('description')) data.description = String(b.description || '').trim().slice(0, 500);
  if (!existing || has('targetType')) data.targetType = b.targetType === 'category' ? 'category' : 'product';
  const type = data.targetType || (existing && existing.targetType) || 'product';

  if (!existing || has('product') || has('category') || has('targetType')) {
    if (type === 'product') {
      const id = has('product') ? b.product : existing && existing.product;
      if (!isId(id)) return { error: 'اختر الصنف الذي يفتحه العرض' };
      const p = await Product.findById(id).select('nameAr price').lean();
      if (!p) return { error: 'الصنف غير موجود' };
      data.product = p._id; data.category = null;
    } else {
      const id = has('category') ? b.category : existing && existing.category;
      if (!isId(id)) return { error: 'اختر التصنيف الذي يفتحه العرض' };
      const c = await Category.findById(id).select('nameAr').lean();
      if (!c) return { error: 'التصنيف غير موجود' };
      data.category = c._id; data.product = null;
    }
  }

  if (!existing || has('discount')) {
    const d = Number(b.discount || 0);
    if (!Number.isFinite(d) || d < 0) return { error: 'الخصم رقم موجب بالدينار (أو 0 بلا خصم)' };
    data.discount = round3(d);
  }
  const productId = data.product !== undefined ? data.product : existing && existing.product;
  const discount = data.discount !== undefined ? data.discount : existing && existing.discount;
  if (type === 'product' && productId && discount > 0) {
    const p = await Product.findById(productId).select('price').lean();
    if (p && discount >= Number(p.price || 0)) return { error: `الخصم (${discount.toFixed(2)} د.أ) يجب أن يكون أقل من سعر الصنف (${Number(p.price).toFixed(2)} د.أ)` };
  }

  if (!existing || has('startDate')) {
    const s = parseDate(b.startDate);
    if (s === undefined) return { error: 'تاريخ البداية غير صالح' };
    data.startDate = s || (existing ? existing.startDate : new Date());
  }
  if (!existing || has('endDate')) {
    const e = parseDate(b.endDate);
    if (e === undefined) return { error: 'تاريخ النهاية غير صالح' };
    data.endDate = e;
  }
  const start = data.startDate || (existing && existing.startDate);
  const end = data.endDate !== undefined ? data.endDate : existing && existing.endDate;
  if (start && end && new Date(end) <= new Date(start)) return { error: 'تاريخ النهاية يجب أن يكون بعد البداية' };

  if (has('isActive')) data.isActive = !(b.isActive === false || b.isActive === 'false' || b.isActive === '0');
  return { data };
}

/** أسماء الهدف وصورته (بلا populate — يعمل مع أي قاعدة). */
async function decorate(list) {
  const pIds = list.map((o) => o.product).filter(isId);
  const cIds = list.map((o) => o.category).filter(isId);
  const [ps, cs] = await Promise.all([
    pIds.length ? Product.find({ _id: { $in: pIds } }).select('nameAr nameEn price image category isAvailable').lean() : [],
    cIds.length ? Category.find({ _id: { $in: cIds } }).select('nameAr nameEn image').lean() : [],
  ]);
  const P = new Map(ps.map((p) => [String(p._id), p])); const C = new Map(cs.map((c) => [String(c._id), c]));
  const now = new Date();
  return list.map((o) => ({
    ...o,
    product: o.product ? P.get(String(o.product)) || { _id: o.product, nameAr: '(صنف محذوف)', missing: true } : null,
    category: o.category ? C.get(String(o.category)) || { _id: o.category, nameAr: '(تصنيف محذوف)', missing: true } : null,
    live: Offer.isLive(o, now),
    shareUrl: o.code ? `${siteUrl()}/o/${o.code}` : '',
    state: o.isActive === false ? 'stopped' : o.startDate && new Date(o.startDate) > now ? 'scheduled' : o.endDate && new Date(o.endDate) < now ? 'ended' : 'live',
  }));
}

/* ─── الإدارة ─── */
const list = async (req, res) => {
  const offers = await Offer.find({}).sort({ createdAt: -1 }).limit(300).lean();
  res.json({ success: true, offers: await decorate(offers) });
};

function applyFiles(req, doc, data) {
  const media = fileOf(req, 'media'); const cover = fileOf(req, 'cover');
  const b = req.body || {};
  if (b.removeMedia === '1' || b.removeMedia === true) { data.mediaUrl = ''; data.mediaType = ''; }
  if (b.removeCover === '1' || b.removeCover === true) data.coverUrl = '';
  if (media) { data.mediaUrl = media.path; data.mediaType = isVideoFile(media) ? 'video' : 'image'; }
  if (cover) {
    if (isVideoFile(cover)) return 'الغلاف يجب أن يكون صورة (jpg, png, webp)';
    data.coverUrl = cover.path;
  }
  return null;
}

const create = async (req, res) => {
  const { data, error } = await readForm(req.body, null);
  if (error) return bad(res, 400, error);
  const fe = applyFiles(req, null, data); if (fe) return bad(res, 400, fe);
  const offer = await Offer.create({
    ...data, code: await newCode(), isActive: data.isActive !== false,
    createdBy: req.user ? req.user._id : null, createdByName: req.user ? req.user.name || req.user.username || '' : '',
  });
  logActivity({ req, action: 'offer.create', details: { title: offer.title, code: offer.code, discount: offer.discount, target: offer.targetType } });
  res.status(201).json({ success: true, offer: (await decorate([offer.toObject ? offer.toObject() : offer]))[0] });
};

const update = async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 400, 'معرّف غير صالح');
  const existing = await Offer.findById(req.params.id).lean();
  if (!existing) return bad(res, 404, 'العرض غير موجود');
  const { data, error } = await readForm(req.body, existing);
  if (error) return bad(res, 400, error);
  const fe = applyFiles(req, existing, data); if (fe) return bad(res, 400, fe);
  await Offer.updateOne({ _id: existing._id }, { $set: data });
  const fresh = await Offer.findById(existing._id).lean();
  logActivity({ req, action: 'offer.update', details: { title: fresh.title, code: fresh.code, fields: Object.keys(data) } });
  res.json({ success: true, offer: (await decorate([fresh]))[0] });
};

const remove = async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 400, 'معرّف غير صالح');
  const o = await Offer.findById(req.params.id).lean();
  if (!o) return bad(res, 404, 'العرض غير موجود');
  await Offer.deleteOne({ _id: o._id });
  logActivity({ req, action: 'offer.delete', details: { title: o.title, code: o.code } });
  res.json({ success: true });
};

/* ─── عام ─── */
async function liveByCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9]{4,24}$/.test(c)) return null;
  const o = await Offer.findOne({ code: c }).lean();
  if (!o) return null;
  return (await decorate([o]))[0];
}

/** للموقع: ما يلزم لعرض الصنف/التصنيف بسعر العرض — بلا أي حقل إداري. */
function publicShape(o) {
  return {
    id: String(o._id), code: o.code, title: o.title, description: o.description, live: o.live,
    targetType: o.targetType, discount: o.discount, mediaUrl: o.mediaUrl, mediaType: o.mediaType, coverUrl: o.coverUrl,
    endDate: o.endDate,
    product: o.product && !o.product.missing ? { _id: o.product._id, nameAr: o.product.nameAr, nameEn: o.product.nameEn, price: o.product.price, image: o.product.image, isAvailable: o.product.isAvailable !== false } : null,
    category: o.category && !o.category.missing ? { _id: o.category._id, nameAr: o.category.nameAr, nameEn: o.category.nameEn } : null,
  };
}

const publicOne = async (req, res) => {
  const o = await liveByCode(req.params.code);
  if (!o) return bad(res, 404, 'العرض غير موجود');
  if (!o.live) return res.status(410).json({ success: false, code: 'OFFER_ENDED', message: o.state === 'scheduled' ? 'العرض لم يبدأ بعد' : 'انتهى هذا العرض', offer: { title: o.title, state: o.state } });
  res.json({ success: true, offer: publicShape(o) });
};

/* ─── صفحة المشاركة /o/:code ─── */
const BOT_RX = /facebookexternalhit|facebot|meta-externalagent|twitterbot|whatsapp|telegrambot|slackbot|linkedinbot|discordbot|skypeuripreview|pinterest|googlebot|bingbot|applebot|vkshare|redditbot|embedly|quora link preview|iframely/i;
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toFixed(2);

function absolute(req, u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/$/, '') + (u.startsWith('/') ? u : `/${u}`);
}

const sharePage = async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  const o = await liveByCode(code);
  const Setting = require('../models/Setting');
  const s = (await Setting.findOne().select('restaurantName logo').lean()) || {};
  const site = siteUrl();
  const target = `${site}/?offer=${encodeURIComponent(code)}`;
  const bot = BOT_RX.test(String(req.headers['user-agent'] || ''));
  const brand = s.restaurantName || 'مطاعم ديار الأنباط';

  let title; let desc; let image; let video = '';
  if (!o) {
    title = brand; desc = 'اطلب مباشرة من المينيو الإلكتروني'; image = absolute(req, s.logo);
  } else {
    const p = o.product && !o.product.missing ? o.product : null;
    const priceLine = p && o.discount > 0
      ? `بدل ${money(p.price)} د.أ ← ${money(Math.max(0, p.price - o.discount))} د.أ`
      : o.discount > 0 ? `خصم ${money(o.discount)} د.أ على كل صنف` : '';
    title = `${o.title} | ${brand}`;
    desc = [priceLine, o.description, o.live ? 'اطلب مباشرة الآن' : 'انتهى العرض — تصفّح المينيو'].filter(Boolean).join(' — ').slice(0, 300);
    const fallbackImg = (p && p.image) || (o.category && o.category.image) || s.logo;
    image = absolute(req, o.mediaType === 'image' ? o.mediaUrl : o.coverUrl || fallbackImg);
    if (o.mediaType === 'video') video = absolute(req, o.mediaUrl);
  }
  if (o && !bot) Offer.updateOne({ _id: o._id }, { $inc: { views: 1 } }).catch(() => {});

  const ogUrl = `${site}/o/${encodeURIComponent(code)}`;
  const vType = /\.webm(\?|$)/i.test(video) ? 'video/webm' : 'video/mp4';
  const meta = [
    ['og:type', video ? 'video.other' : 'website'], ['og:site_name', brand], ['og:locale', 'ar_AR'],
    ['og:title', title], ['og:description', desc],
    ['og:url', ogUrl],
    ...(image ? [['og:image', image], ['og:image:secure_url', image], ['og:image:alt', title]] : []),
    ...(video ? [['og:video', video], ['og:video:url', video], ['og:video:secure_url', video], ['og:video:type', vType], ['og:video:width', '1280'], ['og:video:height', '720']] : []),
  ].map(([k, v]) => `<meta property="${k}" content="${escHtml(v)}">`).join('\n  ');
  const tw = `<meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(title)}">
  <meta name="twitter:description" content="${escHtml(desc)}">${image ? `\n  <meta name="twitter:image" content="${escHtml(image)}">` : ''}`;
  // الزواحف: الوسوم فقط. الزبون: تحويل فوري للعرض في الموقع (بلا 302 حتى يعمل خلف بروكسي Netlify)
  const go = bot ? '' : `<meta http-equiv="refresh" content="0;url=${escHtml(target)}">
  <script>location.replace(${JSON.stringify(target)});</script>`;

  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escHtml(desc)}">
  ${meta}
  ${tw}
  ${go}
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0906;color:#f0e6d2;font-family:Tajawal,system-ui,sans-serif;text-align:center}
  img{max-width:min(92vw,520px);border-radius:16px;display:block;margin:0 auto 1rem}a{color:#c9a84c;font-weight:700}</style>
</head>
<body>
  <main>
    ${image ? `<img src="${escHtml(image)}" alt="">` : ''}
    <h1 style="font-size:1.2rem">${escHtml(title)}</h1>
    <p>${escHtml(desc)}</p>
    <p><a href="${escHtml(target)}">افتح العرض واطلب الآن</a></p>
  </main>
</body>
</html>`);
};

module.exports = wrapAll({ list, create, update, remove, publicOne, sharePage });
module.exports._test = { BOT_RX, publicShape };
