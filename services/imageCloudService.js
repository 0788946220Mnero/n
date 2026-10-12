/*
  ═══════════════════════════════════════════════════════════════
  سحابة الصور الخاصة — عميل ImageStorage (يعمل داخل DiyarPOS على جهاز المطعم).

  • الرفع: POST {baseUrl}/api/v1/images  (X-Api-Key، والبصمة SHA-256 للتحقق من سلامة الملف)
  • الرابط المحفوظ: {baseUrl}/media/{id}/{medium|large} — رابط عام ثابت يعرض نسخة مصغّرة
    (الأصل محمي ولا يُعرض للعامة).
  • الإعدادات في قاعدة البيانات (ImageCloud) ويضبطها مدير النظام فقط؛ المفتاح لا يُعاد لأي واجهة.
  • إن لم يرد جهاز الصور (مطفأ/بلا إنترنت) يرجع الرفع لـ Cloudinary فلا يتوقف العمل.
  ═══════════════════════════════════════════════════════════════
*/
const crypto = require('crypto');
const ImageCloud = require('../models/ImageCloud');
const relay = require('./imageRelayService');

/**
 * الطلب لخدمة الصور: مباشرة على الرابط العام (نفق Cloudflare مثلاً)، أو — إن كان الرابط
 * نفق خادم ديار (/api/image-cloud/relay) — عبر اتصال الجهاز داخل هذا الخادم بلا خروج للإنترنت.
 */
function cfgFetch(cfg, path, init = {}) {
  if (relay.isRelayUrl(cfg.baseUrl)) { const { signal, ...rest } = init; return relay.relayFetch(path, rest, cfg.keyNodeId); }
  return fetch(`${cfg.baseUrl}${path}`, init);
}

const TTL_MS = 15000;
const UPLOAD_TIMEOUT_MS = Number(process.env.IMAGE_CLOUD_TIMEOUT_MS || 30000);
let cache = null; let cacheAt = 0;

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

async function getDoc({ withKey = false } = {}) {
  let q = ImageCloud.findOne({ key: 'main' });
  if (withKey) q = q.select('+apiKey');
  const doc = await q.lean();
  return doc || null;
}

/** الإعدادات الفعّالة (مع المفتاح) — أو null إن كانت السحابة غير مفعّلة. مخزّنة مؤقتاً 15 ثانية. */
async function activeConfig() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache.enabled ? cache : null;
  const d = await getDoc({ withKey: true });
  cache = d ? { enabled: !!d.enabled, baseUrl: trimUrl(d.baseUrl), apiKey: d.apiKey || '', projectId: d.projectId || '', keyNodeId: d.keyNodeId || '' } : { enabled: false };
  cacheAt = Date.now();
  relay.setPreferred(cache.keyNodeId); // النفق يوجّه لصاحب المفتاح أولاً
  return cache.enabled && cache.baseUrl && cache.apiKey ? cache : null;
}
/** مفعّلة لكن ناقصة (بلا مفتاح/رابط) — السبب ليُسجَّل بدل الرجوع الصامت لـ Cloudinary. */
function inactiveReason() {
  if (!cache || !cache.enabled) return '';
  if (!cache.apiKey) return 'لا يوجد مفتاح رفع — بانتظار أن يرسله جهاز الكاشير المتصل';
  if (!cache.baseUrl) return 'لم يُضبط رابط سحابة الصور';
  return '';
}
function invalidate() { cache = null; cacheAt = 0; }

const mediaUrl = (base, id, variant = 'large') => `${trimUrl(base)}/media/${encodeURIComponent(id)}/${variant}`;

/** رسالة الخطأ من ردّ ImageStorage ({ error: { code, message } }). */
async function errorOf(res) {
  let msg = `HTTP ${res.status}`;
  try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch (_) { /* */ }
  const e = new Error(msg); e.status = res.status; return e;
}

/**
 * يرفع صورة ويعيد { id, url, variants }.
 * opts: { filename, mime, folder, variant: 'medium'|'large', cfg }
 */
async function upload(buffer, opts = {}) {
  const cfg = opts.cfg || await activeConfig();
  if (!cfg) { const e = new Error('سحابة الصور غير مفعّلة'); e.status = 0; throw e; }
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: opts.mime || 'application/octet-stream' }), opts.filename || 'image.jpg');
  if (opts.folder) form.append('folder', String(opts.folder).slice(0, 120));
  if (opts.name) form.append('name', String(opts.name).slice(0, 200));
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  let res;
  try {
    res = await cfgFetch(cfg, '/api/v1/images', {
      method: 'POST',
      headers: { 'X-Api-Key': cfg.apiKey, 'X-Content-SHA256': sha },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`جهاز الصور لا يرد: ${err.cause && err.cause.code ? err.cause.code : err.message}`); e.status = 0; throw e;
  }
  if (!res.ok) {
    const e = await errorOf(res);
    // الجهاز رفض المفتاح (مفتاح جهاز آخر، أو أُبطل) ← نطلب مفتاحاً من الجهاز المتصل مع نبضه التالي
    if (res.status === 401 || res.status === 403) {
      e.message = `جهاز الصور رفض مفتاح الرفع (${e.message}) — يُطلب مفتاح جديد من جهاز الكاشير تلقائياً`;
      ImageCloud.updateOne({ key: 'main' }, { $set: { keyRejectedAt: new Date() } }).catch(() => {});
    }
    throw e;
  }
  const body = await res.json();
  return { id: body.id, url: mediaUrl(cfg.baseUrl, body.id, opts.variant || 'large'), variants: body.variants || {} };
}

async function remove(id, cfgIn) {
  const cfg = cfgIn || await activeConfig();
  if (!cfg || !id) return false;
  try {
    const res = await cfgFetch(cfg, `/api/v1/images/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-Api-Key': cfg.apiKey }, signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch (_) { return false; }
}

/**
 * فحص الاتصال: الخدمة ترد، والمفتاح صالح ويملك صلاحية القراءة.
 * يرجع { ok, node, message, ms }.
 */
async function test(cfgIn) {
  const t0 = Date.now();
  const cfg = cfgIn || await (async () => { const d = await getDoc({ withKey: true }); return d && { baseUrl: trimUrl(d.baseUrl), apiKey: d.apiKey }; })();
  if (!cfg || !cfg.baseUrl) return { ok: false, message: 'لم يُضبط رابط سحابة الصور بعد' };
  if (!/^https?:\/\//i.test(cfg.baseUrl)) return { ok: false, message: 'الرابط يجب أن يبدأ بـ https://' };
  let health;
  try {
    const r = await cfgFetch(cfg, '/api/v1/health', { signal: AbortSignal.timeout(8000) });
    health = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: `الخدمة ردّت بـ ${r.status}`, ms: Date.now() - t0 };
  } catch (err) {
    if (relay.isRelayUrl(cfg.baseUrl)) return { ok: false, message: `${err.message}`, ms: Date.now() - t0 };
    return { ok: false, message: `جهاز الصور لا يرد على ${cfg.baseUrl} — تأكد أن DiyarPOS يعمل والنفق متصل`, ms: Date.now() - t0 };
  }
  if (!cfg.apiKey) return { ok: false, node: health.node, message: 'الخدمة تعمل لكن المفتاح غير مضبوط', ms: Date.now() - t0 };
  try {
    const r = await cfgFetch(cfg, '/api/v1/images?page=1&pageSize=1', { headers: { 'X-Api-Key': cfg.apiKey }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { const e = await errorOf(r); return { ok: false, node: health.node, message: `المفتاح مرفوض: ${e.message}`, ms: Date.now() - t0 }; }
  } catch (err) {
    return { ok: false, node: health.node, message: 'تعذّر التحقق من المفتاح', ms: Date.now() - t0 };
  }
  const low = health.storage && health.storage.lowSpace;
  return { ok: true, node: health.node || '', lowSpace: !!low, message: low ? 'متصل — لكن مساحة القرص منخفضة' : 'متصل', ms: Date.now() - t0 };
}

/** تسجيل نجاح/فشل (بلا انتظار — لا يبطئ الرفع). */
function note(ok, err, extra = {}) {
  const $set = ok ? { lastOkAt: new Date(), lastError: '' } : { lastError: String((err && err.message) || err || '').slice(0, 300), lastErrorAt: new Date() };
  const $inc = {};
  if (extra.upload) $inc.uploads = 1;
  if (extra.fallback) $inc.fallbacks = 1;
  const update = Object.keys($inc).length ? { $set, $inc } : { $set };
  ImageCloud.updateOne({ key: 'main' }, update).catch(() => {});
}

/** الصفحة/المسار ← حجم الصورة المحفوظ: الأصناف والتصنيفات medium (960px)، والباقي large (1920px). */
function variantFor(req) {
  const p = `${(req && (req.originalUrl || req.baseUrl)) || ''}`;
  return /\/api\/(products|categories)(\/|\?|$)/.test(p) ? 'medium' : 'large';
}
function folderFor(req) {
  const p = `${(req && (req.originalUrl || req.baseUrl)) || ''}`.replace(/^\/api\//, '');
  return p.split(/[/?]/)[0] || 'misc';
}

module.exports = { activeConfig, invalidate, upload, remove, test, note, mediaUrl, getDoc, variantFor, folderFor, trimUrl, inactiveReason };
