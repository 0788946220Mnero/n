/*
  سحابة الصور — إعدادات مدير النظام (صلاحية images:cloud).
    GET  /api/image-cloud            الحالة (بلا المفتاح أبداً)
    PUT  /api/image-cloud            الربط/التعديل/الإيقاف (يختبر الاتصال قبل التفعيل)
    POST /api/image-cloud/test       اختبار الاتصال الآن
    GET  /api/image-cloud/migrate    حالة النقل (?preview=1: كم صورة على Cloudinary)
    POST /api/image-cloud/migrate    نقل كل الصور من Cloudinary (في الخلفية)
  DiyarPOS يستدعي PUT نفسه بجلسة مدير النظام بعد أن يشغّل الخدمة وينشئ المفتاح.
*/
const { wrapAll } = require('../utils/asyncHandler');
const ImageCloud = require('../models/ImageCloud');
const imageCloud = require('../services/imageCloudService');
const migration = require('../services/imageMigrationService');
const nodesSvc = require('../services/imageCloudNodes');
const realtime = require('../services/realtimeService');

const nameOf = (u) => (u && (u.name || u.username)) || '';

async function view() {
  const d = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
  if (!d) return { enabled: false, baseUrl: '', projectId: '', hasKey: false, migration: await migration.status() };
  return {
    enabled: !!d.enabled, baseUrl: d.baseUrl || '', projectId: d.projectId || '',
    hasKey: !!d.apiKey, keyHint: d.apiKey ? `…${String(d.apiKey).slice(-4)}` : '',
    nodeName: d.nodeName || '', linkedFrom: d.linkedFrom || '', updatedByName: d.updatedByName || '', updatedAt: d.updatedAt,
    lastOkAt: d.lastOkAt, lastError: d.lastError || '', lastErrorAt: d.lastErrorAt,
    uploads: d.uploads || 0, fallbacks: d.fallbacks || 0,
    syncReady: !!d.syncSecret || (d.nodes || []).length > 0,
    nodes: nodesSvc.view(d.nodes || []),
    migration: await migration.status(),
  };
}

const get = async (req, res) => res.json({ success: true, cloud: await view() });

const update = async (req, res) => {
  const b = req.body || {};
  const cur = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
  const next = {
    enabled: b.enabled != null ? !!b.enabled : !!(cur && cur.enabled),
    baseUrl: b.baseUrl != null ? imageCloud.trimUrl(b.baseUrl) : (cur && cur.baseUrl) || '',
    projectId: b.projectId != null ? String(b.projectId).trim().slice(0, 64) : (cur && cur.projectId) || '',
    apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : (cur && cur.apiKey) || '',
  };
  if (next.baseUrl && !/^https?:\/\/[^\s/]+/i.test(next.baseUrl)) return res.status(400).json({ success: false, message: 'الرابط غير صالح — مثال: https://images.diyaralanbat.com' });
  if (next.apiKey && !/^isk_[A-Za-z0-9_-]{10,}$/.test(next.apiKey)) return res.status(400).json({ success: false, message: 'صيغة المفتاح غير صحيحة (يبدأ بـ isk_)' });
  if (next.enabled) {
    if (!next.baseUrl || !next.apiKey) return res.status(400).json({ success: false, message: 'الرابط والمفتاح مطلوبان للتفعيل' });
    // لا نفعّل سحابة لا ترد — وإلا رجعت كل الصور لـ Cloudinary بصمت
    const t = await imageCloud.test(next);
    if (!t.ok && !b.force) return res.status(400).json({ success: false, message: t.message, test: t });
    if (t.ok) next.nodeName = t.node || '';
  }
  const $set = { ...next, updatedByName: nameOf(req.user) };
  if (b.nodeName) $set.nodeName = String(b.nodeName).slice(0, 80);
  if (b.linkedFrom != null) $set.linkedFrom = String(b.linkedFrom).slice(0, 80);
  if (next.enabled) { $set.lastOkAt = new Date(); $set.lastError = ''; }
  await ImageCloud.updateOne({ key: 'main' }, { $set }, { upsert: true });
  imageCloud.invalidate();
  res.json({ success: true, cloud: await view() });
};

const test = async (req, res) => {
  const t = await imageCloud.test();
  imageCloud.note(t.ok, t.ok ? null : new Error(t.message));
  res.json({ success: true, test: t });
};

const migrateStatus = async (req, res) => {
  const out = { success: true, migration: await migration.status() };
  if (req.query.preview) {
    const { unique, docs } = await migration.scan();
    out.preview = { images: unique.size, docs: docs.length };
  }
  res.json(out);
};

const migrateStart = async (req, res) => {
  try {
    const r = await migration.start(nameOf(req.user));
    res.status(r.already ? 200 : 202).json({ success: true, ...r, migration: await migration.status() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

/* ═══ أجهزة المزامنة ═══ */
const fail = (res, err) => res.status(err.status || 500).json({ success: false, message: err.message });

/** انضمام جهاز DiyarPOS للمزامنة (مدير النظام): يأخذ الأسرار وقائمة الأجهزة. */
const nodeJoin = async (req, res) => {
  try { res.json({ success: true, ...(await nodesSvc.join(req.user, req.body || {})) }); } catch (err) { fail(res, err); }
};

/** نبض جهاز منضم (أي مستخدم مسجّل على الجهاز): حالته ← الأجهزة الأخرى. */
const nodeHeartbeat = async (req, res) => {
  try { res.json({ success: true, ...(await nodesSvc.heartbeat(req.body || {}, realtime.broadcast)) }); } catch (err) { fail(res, err); }
};

const nodeRemove = async (req, res) => {
  await nodesSvc.remove(String(req.params.nodeId || ''));
  res.json({ success: true, cloud: await view() });
};

module.exports = wrapAll({ get, update, test, migrateStatus, migrateStart, nodeJoin, nodeHeartbeat, nodeRemove });
