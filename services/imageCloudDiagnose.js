/*
  ═══════════════════════════════════════════════════════════════
  IMAGE-SERVER: تشخيص سحابة الصور خطوة بخطوة — «أين يفشل الاتصال بالضبط؟»

  يمر بنفس المسار الذي تمر به الصور فعلاً، ويقف عند أول خطوة فاشلة بسببها:
    1) الإعداد       مفعّلة؟ أي رابط (نفق سيرفر ميرو السحابي / رابط عام / محلي لا يُوصَل)؟ مفتاح؟
    2) الوصول       النفق: هل جهاز متصل، وهل هو صاحب المفتاح؟ — الرابط العام: هل يرد؟
    3) الخدمة       /api/v1/health على جهاز الصور (الجهاز، القرص قابل للكتابة، المساحة)
    4) المفتاح      قراءة بالمفتاح (401 = مفتاح جهاز آخر أو أُبطل)
    5) الرفع        صورة اختبار صغيرة (PNG مولّدة) إلى مجلد diagnostics
    6) العرض        النسخة medium والمصغّرة small(thumb) من الرابط العام كما يراها الزبون
    7) الأصل        /original محمي افتراضياً (403 = سليم — لا يُعرض للعامة)
    8) الحذف        حذف صورة الاختبار
    9) Cloudinary   كم رابطاً بقي، وهل النقل ممكن الآن
  لا يكشف المفتاح ولا أي سر: يظهر آخر 4 أحرف فقط. صورة الاختبار تُحذف دائماً.
  ═══════════════════════════════════════════════════════════════
*/
const ImageCloud = require('../models/ImageCloud');
const imageCloud = require('./imageCloudService');
const relay = require('./imageRelayService');

function tinyPng() {
  // صورة PNG حقيقية 64×64 (تُفك وتُصغَّر كأي صورة) — بلا ملفات خارجية
  return require('./appleWalletService').solidPng(64, 64, '#1f1a17', '#d4a017');
}

async function timed(fn) {
  const t0 = Date.now();
  try { const out = await fn(); return { ...out, ms: Date.now() - t0 }; } catch (e) { return { ok: false, message: e.message, ms: Date.now() - t0 }; }
}

/**
 * @param {object} opts { req } — لبناء رابط النفق إن لم يُحفظ بعد
 * @returns {{ ok, summary, steps: [{ key, label, ok: true|false|null, message, ms }] }}
 *   ok=null: معلومة أو خطوة تُخطّيت لأن ما قبلها فشل
 */
async function diagnose({ req } = {}) {
  const steps = [];
  const add = (key, label, r) => { steps.push({ key, label, ok: r.ok, message: r.message, ms: r.ms }); return r.ok !== false; };
  const skip = (key, label) => steps.push({ key, label, ok: null, message: 'تُخطّيت — فشلت خطوة سابقة' });

  const d = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
  // 1) الإعداد
  const base = imageCloud.trimUrl((d && d.baseUrl) || '');
  const mode = !base ? 'none' : relay.isRelayUrl(base) ? 'relay' : relay.isPrivateUrl(base) ? 'private' : 'public';
  const cfg = { baseUrl: mode === 'none' || mode === 'private' ? relay.baseFor(req) : base, apiKey: (d && d.apiKey) || '', keyNodeId: (d && d.keyNodeId) || '' };
  const modeText = { relay: 'عبر نفق سيرفر ميرو السحابي', public: `رابط عام ${base}`, private: `رابط محلي ${base} — لا يصله الخادم من الإنترنت (يُستبدل بالنفق)`, none: 'لا رابط محفوظ (سيُستخدم النفق)' }[mode];
  const state = !d ? 'لم تُضبط بعد' : d.enabled ? 'مفعّلة' : d.wantEnabled ? 'بانتظار التفعيل' : 'غير مفعّلة';
  const cfgOk = !!(d && cfg.apiKey);
  add('config', 'الإعداد', {
    ok: cfgOk,
    message: `${state} · ${modeText} · ${cfg.apiKey ? `المفتاح محفوظ (…${cfg.apiKey.slice(-4)})` : 'لا يوجد مفتاح رفع — يرسله جهاز الكاشير بعد الموافقة'}`
      + ` · Cloudinary: ${!imageCloud.cloudinaryUploads() ? 'موقوف' : d && d.cloudinaryFallback ? 'احتياط مسموح' : 'احتياط معطّل'}${d && d.lastError ? ` · آخر خطأ: ${d.lastError}` : ''}`,
  });

  // 2) الوصول
  let reachOk = false;
  if (mode === 'public') {
    const r = await timed(async () => {
      const res = await fetch(`${cfg.baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(8000) });
      return { ok: res.ok, message: res.ok ? `الرابط العام يرد (${res.status})` : `الرابط العام ردّ بـ ${res.status} — ليس خادم الصور` };
    });
    if (!r.ok && /fetch failed|ENOTFOUND|ECONNREFUSED|timeout|aborted/i.test(r.message || '')) {
      r.message = `الرابط العام ${base} لا يرد (${r.message}) — لا نفق Cloudflare يعمل عليه؛ النفق عبر سيرفر ميرو السحابي ${relay.connectedCount() ? 'متصل ويُستخدم تلقائياً' : 'غير متصل أيضاً'}`;
    }
    reachOk = add('reach', 'الوصول', r);
    if (!reachOk && relay.connectedCount()) { cfg.baseUrl = relay.baseFor(req); reachOk = true; }
  } else {
    const devs = relay.status();
    const owner = cfg.keyNodeId && devs.some((x) => x.nodeId === cfg.keyNodeId);
    reachOk = add('reach', 'الوصول', {
      ok: devs.length > 0,
      message: devs.length
        ? `متصل بالنفق: ${devs.map((x) => x.name || x.nodeId).join('، ')}${cfg.keyNodeId && !owner ? ` — تنبيه: صاحب المفتاح (${cfg.keyNodeId}) غير متصل` : ''}`
        : 'لا يوجد جهاز صور متصل بالخادم — DiyarPOS مطفأ أو بلا إنترنت، أو لم يُوافَق على الجهاز',
    });
  }

  // 3) الخدمة
  let healthOk = false;
  if (reachOk) {
    healthOk = add('health', 'خدمة الصور', await timed(async () => {
      const r = await imageCloud._fetch(cfg, '/api/v1/health', { signal: AbortSignal.timeout(8000) });
      const h = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, message: `الخدمة ردّت بـ ${r.status}` };
      const st = h.storage || {};
      if (st.writable === false) return { ok: false, message: `الجهاز ${h.node || ''}: القرص غير قابل للكتابة` };
      return { ok: true, message: `الجهاز ${h.node || '؟'} يعمل${st.lowSpace ? ' — تنبيه: المساحة منخفضة' : ''}` };
    }));
  } else skip('health', 'خدمة الصور');

  // 4) المفتاح
  let keyOk = false;
  if (healthOk && cfg.apiKey) {
    keyOk = add('key', 'مفتاح الرفع', await timed(async () => {
      const r = await imageCloud._fetch(cfg, '/api/v1/images?page=1&pageSize=1', { headers: { 'X-Api-Key': cfg.apiKey }, signal: AbortSignal.timeout(8000) });
      if (r.ok) return { ok: true, message: 'المفتاح مقبول' };
      return { ok: false, message: r.status === 401 || r.status === 403 ? `المفتاح مرفوض (${r.status}) — مفتاح جهاز آخر أو أُبطل؛ الخادم يطلب مفتاح الجهاز المتصل تلقائياً` : `ردّ بـ ${r.status}` };
    }));
  } else skip('key', 'مفتاح الرفع');

  // 5-8) رفع، عرض، أصل، حذف
  let up = null;
  if (keyOk) {
    const r = await timed(async () => {
      up = await imageCloud.upload(tinyPng(), { cfg, filename: 'diyar-diagnose.png', mime: 'image/png', folder: 'diagnostics', variant: 'medium' });
      return { ok: true, message: `رُفعت صورة الاختبار ${up.id}` };
    });
    add('upload', 'رفع صورة', r);
  } else skip('upload', 'رفع صورة');

  if (up) {
    const m = await timed(async () => { const v = await imageCloud.verifyMedia(cfg, up.id, 'medium'); return v.ok ? { ok: true, message: `medium تُعرض (${v.size} بايت) من ${cfg.baseUrl}` } : v; });
    add('view', 'عرض الصورة', m);
    const t = await timed(async () => { const v = await imageCloud.verifyMedia(cfg, up.id, 'small'); return v.ok ? { ok: true, message: `المصغّرة small/thumb تُعرض (${v.size} بايت)` } : v; });
    add('thumb', 'الصورة المصغّرة', t);
    add('original', 'الأصل محمي', await timed(async () => {
      const r = await imageCloud._fetch(cfg, `/media/${encodeURIComponent(up.id)}/original`, { signal: AbortSignal.timeout(8000) });
      await r.arrayBuffer().catch(() => null);
      if (r.status === 403) return { ok: true, message: 'الأصل لا يُعرض للعامة بلا رابط موقّع — كما يجب' };
      if (r.ok) return { ok: null, message: 'الأصل يُعرض للعامة (المشروع غير محمي) — مقبول، لكن الحماية مستحسنة' };
      return { ok: null, message: `ردّ بـ ${r.status}` };
    }));
    add('delete', 'حذف صورة الاختبار', await timed(async () => {
      const ok = await imageCloud.remove(up.id, cfg);
      return { ok, message: ok ? 'حُذفت' : 'تعذّر الحذف (تبقى في مجلد diagnostics ولا تضر)' };
    }));
  } else ['view', 'thumb', 'original', 'delete'].forEach((k) => skip(k, { view: 'عرض الصورة', thumb: 'الصورة المصغّرة', original: 'الأصل محمي', delete: 'حذف صورة الاختبار' }[k]));

  // 9) Cloudinary
  add('cloudinary', 'روابط Cloudinary', await timed(async () => {
    const { unique } = await Promise.race([require('./imageMigrationService').scan(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('قاعدة البيانات لم ترد خلال 8 ثوانٍ')), 8000))]);
    const n = unique.size;
    if (!n) return { ok: true, message: 'لا روابط Cloudinary — كل الصور على السحابة المحلية (Cloudinary موقوف)' };
    const ready = d && d.enabled && up;
    return { ok: null, message: `${n} صورة ما زالت على Cloudinary — ${ready ? 'النقل ممكن الآن: «انقل كل الصور»' : 'النقل يحتاج سحابة مفعّلة تعمل (الخطوات أعلاه)'}` };
  }));

  const failed = steps.find((s) => s.ok === false);
  return { ok: !failed, summary: failed ? `يفشل عند «${failed.label}»: ${failed.message}` : 'كل الخطوات سليمة — الرفع والعرض والمصغّرات تعمل', steps, at: new Date() };
}

module.exports = { diagnose };
