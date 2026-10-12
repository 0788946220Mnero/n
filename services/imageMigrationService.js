/*
  ═══════════════════════════════════════════════════════════════
  نقل كل الصور من Cloudinary إلى سحابة الصور الخاصة (مرة واحدة، بزر من لوحة التحكم).

  • يبحث عن روابط صور Cloudinary في: الأصناف، التصنيفات، الإعدادات (الشعار، صورة «من نحن»،
    الخلفية، المعرض، لافتات المنيو)، والإشعارات — في أي حقل وبأي عمق.
  • كل رابط فريد يُنزَّل ويُرفع مرة واحدة، ثم يُستبدل في الوثيقة بشرط أن يكون ما زال نفسه
    (لا يدوس تعديلاً حدث أثناء النقل).
  • الفيديو يبقى على Cloudinary. ولا يُحذف شيء من Cloudinary — يبقى نسخة احتياطية.
  • آمن للإعادة: ما نُقل لم يعد رابط Cloudinary فلا يُنقل مرتين؛ وإن انقطع (إعادة تشغيل الخادم)
    يُستأنف من حيث وقف بضغطة أخرى.
  ═══════════════════════════════════════════════════════════════
*/
const path = require('path');
const ImageCloud = require('../models/ImageCloud');
const imageCloud = require('./imageCloudService');

const CLOUD_RX = /^https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//i;
const CONCURRENCY = Number(process.env.IMAGE_MIGRATION_CONCURRENCY || 3);

/** المجموعات ومقاس كل منها. */
function sources() {
  return [
    { model: require('../models/Product'), folder: 'products', variant: 'medium' },
    { model: require('../models/Category'), folder: 'categories', variant: 'medium' },
    { model: require('../models/Setting'), folder: 'settings', variant: 'large' },
    { model: require('../models/Notification'), folder: 'notifications', variant: 'large' },
  ];
}

const isPlain = (v) => v && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);

/** كل روابط Cloudinary في وثيقة: [{ path: 'gallery.2.url', url }]. */
function collect(obj, prefix = '', out = []) {
  if (typeof obj === 'string') { if (CLOUD_RX.test(obj)) out.push({ path: prefix, url: obj }); return out; }
  if (!isPlain(obj)) return out;
  const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
  for (const [k, v] of entries) {
    if (k === '_id' || k === '__v') continue;
    collect(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

let running = null; // الوعد الجاري في هذه العملية

async function save(patch) {
  const $set = {};
  Object.entries(patch).forEach(([k, v]) => { $set[`migration.${k}`] = v; });
  await ImageCloud.updateOne({ key: 'main' }, { $set }, { upsert: true });
}

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`تنزيل من Cloudinary: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, mime: r.headers.get('content-type') || 'image/jpeg' };
}

/** يمسح المجموعات ويعدّ ما سيُنقل (بلا تعديل) — للمعاينة وللبدء. */
async function scan() {
  const docs = [];
  for (const src of sources()) {
    const list = await src.model.collection.find({}).toArray();
    for (const d of list) {
      const refs = collect(d);
      if (refs.length) docs.push({ src, _id: d._id, refs });
    }
  }
  const unique = new Map(); // `${variant}|${url}` → { url, src }
  docs.forEach((d) => d.refs.forEach((r) => {
    const k = `${d.src.variant}|${r.url}`;
    if (!unique.has(k)) unique.set(k, { url: r.url, src: d.src });
  }));
  return { docs, unique };
}

async function run(byName) {
  const cfg = await imageCloud.activeConfig();
  if (!cfg) throw Object.assign(new Error(imageCloud.policy().reason || 'فعّل سحابة الصور واربطها أولاً'), { status: 400 });
  const t = await imageCloud.test(cfg);
  if (!t.ok) throw Object.assign(new Error(t.message), { status: 400 });

  const { docs, unique } = await scan();
  await save({ status: 'running', total: unique.size, done: 0, failed: 0, verified: 0, updatedDocs: 0, remaining: 0,
    startedAt: new Date(), finishedAt: null, byName: byName || '', errors: [] });

  const mapped = new Map(); // key → newUrl (فقط ما تأكدنا أنه يُعرض)
  const errors = [];
  let done = 0; let failed = 0; let lastSave = 0;
  const queue = Array.from(unique.entries());
  const fail = (url, message) => { failed++; if (errors.length < 30) errors.push({ url, message: String(message).slice(0, 200) }); };

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [key, { url, src }] = item;
      try {
        const { buf, mime } = await download(url);
        if (!/^image\//i.test(mime) || !buf.length) throw new Error(`ليس صورة (${mime})`);
        const name = path.basename(new URL(url).pathname) || 'image.jpg';
        // حدّ الرفع في الخدمة (429) أو نسخة قيد التجهيز (503): ننتظر ونعيد حتى 4 مرات
        let r;
        for (let attempt = 0; ; attempt++) {
          try { r = await imageCloud.upload(buf, { cfg, filename: name, mime, folder: src.folder, variant: src.variant }); break; } catch (e) {
            if (![429, 503].includes(e.status) || attempt >= 3) throw e;
            await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
          }
        }
        // «نُقلت» تعني أنها تُعرض من رابطها الجديد — وإلا يبقى رابط Cloudinary كما هو
        const v = await imageCloud.verifyMedia(cfg, r.id, src.variant);
        if (!v.ok) { imageCloud.remove(r.id, cfg).catch(() => {}); throw new Error(v.message); }
        mapped.set(key, r.url);
        done++;
      } catch (err) {
        fail(url, err.message || err);
      }
      if (Date.now() - lastSave > 1500) { lastSave = Date.now(); await save({ done, failed, verified: done, errors }).catch(() => {}); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

  // استبدال الروابط في الوثائق — بشرط أن يبقى الحقل على الرابط القديم
  let updatedDocs = 0; let skipped = 0;
  for (const d of docs) {
    let changed = false;
    for (const ref of d.refs) {
      const nu = mapped.get(`${d.src.variant}|${ref.url}`);
      if (!nu) continue;
      const r = await d.src.model.collection.updateOne({ _id: d._id, [ref.path]: ref.url }, { $set: { [ref.path]: nu } });
      if (r.modifiedCount) changed = true; else skipped++;
    }
    if (changed) updatedDocs++;
  }
  if (skipped && errors.length < 30) errors.push({ url: '', message: `${skipped} رابط تغيّر أثناء النقل (عُدّل يدوياً) فلم يُستبدل` });

  // العدّ الحقيقي: كم رابط Cloudinary بقي في القاعدة بعد النقل
  const after = await scan();
  const remaining = after.unique.size;
  const status = remaining === 0 ? 'done' : (done ? 'partial' : 'failed');
  await save({ status, done, failed, verified: done, updatedDocs, remaining, errors, finishedAt: new Date() });
  return { status, total: unique.size, done, failed, updatedDocs, remaining };
}

/** يبدأ النقل في الخلفية (لا ينتظره الطلب). يرجع الحالة الحالية إن كان يعمل. */
async function start(byName) {
  if (running) return { already: true };
  // فحوص سريعة قبل الرد (رسالة واضحة إن لم تُربط السحابة)
  const cfg = await imageCloud.activeConfig();
  if (!cfg) throw Object.assign(new Error(imageCloud.policy().reason || 'فعّل سحابة الصور واربطها أولاً'), { status: 400 });
  running = run(byName)
    .catch(async (err) => { await save({ status: 'failed', finishedAt: new Date(), errors: [{ url: '', message: String(err.message || err).slice(0, 200) }] }).catch(() => {}); })
    .finally(() => { running = null; });
  return { started: true };
}

/** الحالة كما في قاعدة البيانات + «انقطع» إن كانت running ولا يوجد نقل فعلي في هذه العملية. */
async function status() {
  const d = await ImageCloud.findOne({ key: 'main' }).lean();
  const m = (d && d.migration) || { status: 'idle' };
  if (m.status === 'running' && !running) m.status = 'interrupted';
  return m;
}

module.exports = { start, status, scan, collect, run, _isRunning: () => !!running, CLOUD_RX };
