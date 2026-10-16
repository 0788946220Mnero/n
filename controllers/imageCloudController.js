/*
  سحابة الصور — إعدادات مدير النظام (صلاحية images:cloud).
    GET  /api/image-cloud            الحالة (بلا المفتاح أبداً)
    PUT  /api/image-cloud            الربط/التعديل/الإيقاف (يختبر الاتصال قبل التفعيل)
    POST /api/image-cloud/test       اختبار الاتصال الآن
    GET  /api/image-cloud/migrate    حالة النقل (?preview=1: كم صورة على Cloudinary)
    POST /api/image-cloud/migrate    نقل كل الصور من Cloudinary (في الخلفية)
  الربط التلقائي (بلا نسخ مفتاح):
    POST /nodes/request    DiyarPOS عند تشغيله (أي حساب) ← «بانتظار الموافقة» + إشعار للمدير
    POST /nodes/:id/decide مدير النظام يوافق/يرفض من اللوحة
    POST /nodes/claim      الجهاز المُوافَق عليه يرسل مفتاحه ← ينضم للمزامنة وتُفعَّل السحابة
*/
const { wrapAll } = require('../utils/asyncHandler');
const ImageCloud = require('../models/ImageCloud');
const imageCloud = require('../services/imageCloudService');
const migration = require('../services/imageMigrationService');
const nodesSvc = require('../services/imageCloudNodes');
const realtime = require('../services/realtimeService');
const relay = require('../services/imageRelayService');
const { hasPermission } = require('../middlewares/permission');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const KEY_RX = /^isk_[A-Za-z0-9_-]{10,}$/;

/** إشعار هاتف (FCM) لمدراء النظام — اختياري: لا يتعطّل شيء إن لم يُضبط Firebase. */
async function pushAdmins(title, body) {
  try {
    const push = require('../services/pushService');
    if (!push.isEnabled()) return;
    const User = require('../models/User');
    const Device = require('../models/Device');
    const users = await User.find({ role: 'admin', isActive: true }).select('_id');
    const devices = await Device.find({ user: { $in: users.map((u) => u._id) }, isActive: true }).select('fcmToken');
    const tokens = [...new Set(devices.map((x) => x.fcmToken).filter(Boolean))];
    if (tokens.length) await push.sendToTokens(tokens, { title, body, data: { type: 'imagecloud.request', url: '/dashboard.html#settings' } });
  } catch (err) { console.error('imagecloud push:', err.message); }
}

async function view() {
  const d = await ImageCloud.findOne({ key: 'main' }).select('+apiKey +tunnelToken').lean();
  if (!d) return { enabled: false, baseUrl: '', projectId: '', hasKey: false, migration: await migration.status() };
  return {
    enabled: !!d.enabled, wantEnabled: !d.enabled && !!d.wantEnabled, baseUrl: d.baseUrl || '', projectId: d.projectId || '',
    hasKey: !!d.apiKey, keyHint: d.apiKey ? `…${String(d.apiKey).slice(-4)}` : '',
    nodeName: ((d.nodes || []).find((n) => n.nodeId === d.nodeName) || {}).name || d.nodeName || '', linkedFrom: d.linkedFrom || '', updatedByName: d.updatedByName || '', updatedAt: d.updatedAt,
    lastOkAt: d.lastOkAt, lastError: d.lastError || '', lastErrorAt: d.lastErrorAt,
    uploads: d.uploads || 0, fallbacks: d.fallbacks || 0,
    syncReady: !!d.syncSecret || (d.nodes || []).length > 0,
    hasTunnel: !!d.tunnelToken,
    cloudinaryFallback: !!d.cloudinaryFallback,
    viaRelay: relay.isRelayUrl(d.baseUrl),
    relayDevices: relay.status(),
    nodes: nodesSvc.view(d.nodes || []),
    requests: nodesSvc.requestsView(d.requests),
    migration: await migration.status(),
  };
}

const get = async (req, res) => res.json({ success: true, cloud: await view() });

const update = async (req, res) => {
  const b = req.body || {};
  // مفتاح «الرجوع لـ Cloudinary» وحده: لا يعيد فحص السحابة ولا يغيّر تفعيلها
  if (Object.keys(b).length === 1 && typeof b.cloudinaryFallback === 'boolean') {
    await ImageCloud.updateOne({ key: 'main' }, { $set: { cloudinaryFallback: b.cloudinaryFallback, updatedByName: nameOf(req.user) } }, { upsert: true });
    imageCloud.invalidate();
    return res.json({ success: true, cloud: await view() });
  }
  const cur = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
  const next = {
    enabled: b.enabled != null ? !!b.enabled : !!(cur && cur.enabled),
    baseUrl: b.baseUrl != null ? imageCloud.trimUrl(b.baseUrl) : (cur && cur.baseUrl) || '',
    projectId: b.projectId != null ? String(b.projectId).trim().slice(0, 64) : (cur && cur.projectId) || '',
    apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : (cur && cur.apiKey) || '',
  };
  // رابط محلي (127.0.0.1 / 192.168.x — من DiyarPOS بلا رابط عام) لا يصله الخادم أبداً ← النفق
  if (relay.isPrivateUrl(next.baseUrl)) next.baseUrl = '';
  // بلا رابط خاص: الصور تمر عبر نفق خادم ديار (لا Cloudflare ولا إعداد)
  if (next.enabled && !next.baseUrl) next.baseUrl = relay.baseFor(req);
  if (next.baseUrl && !/^https?:\/\/[^\s/]+/i.test(next.baseUrl)) return res.status(400).json({ success: false, message: 'الرابط غير صالح — مثال: https://images.diyaralanbat.com' });
  if (next.apiKey && !KEY_RX.test(next.apiKey)) return res.status(400).json({ success: false, message: 'صيغة المفتاح غير صحيحة (يبدأ بـ isk_)' });
  let pending = '';
  let notice = ''; // فُعّلت لكن بغير الرابط المرسَل (النفق بدل رابط عام لا يرد)
  if (next.enabled) {
    if (!next.baseUrl || !next.apiKey) return res.status(400).json({ success: false, message: 'الرابط والمفتاح مطلوبان للتفعيل' });
    // لا نفعّل سحابة لا ترد — وإلا رجعت كل الصور لـ Cloudinary بصمت
    const keyNodeId = (typeof b.apiKey === 'string' && b.apiKey.trim()) ? String(b.nodeId || '') : (cur && cur.keyNodeId) || '';
    let t = await imageCloud.test({ ...next, keyNodeId });
    if (!t.ok) {
      const alt = await relayInstead({ ...next, keyNodeId }, req);
      if (alt) { next.baseUrl = alt.baseUrl; t = alt.test; notice = alt.message; }
    }
    if (t.ok) next.nodeName = t.node || '';
    else if (!b.force) {
      // أجهزة منضمة: الرابط ورمز النفق يصلانها مع نبضها التالي ← تُفعَّل تلقائياً حين ترد
      // عبر النفق: الجهاز قد لم يتصل بعد (ينضم الآن) ← يُحفظ ويُفعَّل حين يتصل
      if (!(cur && (cur.nodes || []).length) && !relay.isRelayUrl(next.baseUrl)) return res.status(400).json({ success: false, message: t.message, test: t });
      next.enabled = false;
      pending = relay.isRelayUrl(next.baseUrl)
        ? `حُفظ — الصور تُعرض عبر خادم ديار، وتُفعَّل السحابة تلقائياً حين يتصل جهاز الكاشير ويرسل مفتاحه (خلال دقيقة) — ${t.message}`
        : `حُفظ — يصل الرابط ورمز النفق لجهاز الكاشير خلال دقيقة، وتُفعَّل السحابة تلقائياً حين يرد (${t.message})`;
    }
  }
  const $set = { ...next, updatedByName: nameOf(req.user) };
  if (b.enabled != null) $set.wantEnabled = !!b.enabled;
  if (b.nodeName) $set.nodeName = String(b.nodeName).slice(0, 80);
  if (typeof b.cloudinaryFallback === 'boolean') $set.cloudinaryFallback = b.cloudinaryFallback;
  if (b.linkedFrom != null) $set.linkedFrom = String(b.linkedFrom).slice(0, 80);
  // مفتاح جديد من DiyarPOS: صاحبه هو الجهاز المرسِل (النفق يوجّه إليه)
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) $set.keyNodeId = nodesSvc.ID_RX.test(String(b.nodeId || '')) ? String(b.nodeId) : '';
  // رمز نفق Cloudflare: يُضبط من الهاتف ويصل لأجهزة DiyarPOS مع نبضها التالي
  if (typeof b.tunnelToken === 'string' && b.tunnelToken.trim()) $set.tunnelToken = b.tunnelToken.trim().slice(0, 4000);
  if (b.clearTunnel) $set.tunnelToken = '';
  if (next.enabled) { $set.lastOkAt = new Date(); $set.lastError = ''; }
  await ImageCloud.updateOne({ key: 'main' }, { $set }, { upsert: true });
  imageCloud.invalidate();
  res.json({ success: true, cloud: await view(), ...(pending ? { pending: true, message: pending } : notice ? { message: notice } : {}) });
};

/**
 * الرابط العام (Cloudflare مثلاً) لا يرد والنفق عبر خادم ديار متصل ← نجرّب النفق؛ إن عمل يُستخدم بدله.
 * (كان رابط عام ميت — مثل images.diyaralanbat.com بلا cloudflared — يمنع التفعيل للأبد والنفق شغّال.)
 */
async function relayInstead(cfg, req) {
  if (!req || relay.isRelayUrl(cfg.baseUrl) || !relay.connectedCount() || !cfg.apiKey) return null;
  const base = relay.baseFor(req);
  if (!base) return null;
  const t = await imageCloud.test({ ...cfg, baseUrl: base });
  return t.ok ? { baseUrl: base, test: t, message: `الرابط ${cfg.baseUrl} لا يرد (لا نفق Cloudflare يعمل عليه) — فُعّلت السحابة عبر خادم ديار بدلاً منه` } : null;
}

/**
 * تفعيل تلقائي: المدير يريدها مفعّلة (أو وافق على أول جهاز) والجهاز لم يكن يرد على الرابط العام.
 * مع كل نبض (بفاصل 20 ثانية على الأقل) نختبر؛ عند أول رد تُفعَّل ويُبلَّغ المدير. لا يؤخر رد النبض.
 */
async function tryAutoEnable(req, force = false) {
  let cur = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
  if (cur && cur.enabled) return repairEnabled(cur, req);
  if (!cur || !cur.wantEnabled || !cur.apiKey) return;
  // لا رابط خاص (أو رابط محلي لا يُوصَل إليه) وجهاز متصل بالنفق ← الصور تمر عبر هذا الخادم
  if ((!cur.baseUrl || relay.isPrivateUrl(cur.baseUrl)) && relay.connectedCount() > 0 && req) {
    const base = relay.baseFor(req);
    if (!base) return;
    await ImageCloud.updateOne({ key: 'main' }, { $set: { baseUrl: base } });
    cur = { ...cur, baseUrl: base };
  }
  if (!cur.baseUrl) return;
  if (!force && cur.lastAutoTry && Date.now() - new Date(cur.lastAutoTry).getTime() < 20000) return;
  await ImageCloud.updateOne({ key: 'main' }, { $set: { lastAutoTry: new Date() } });
  let t = await imageCloud.test(cur);
  if (!t.ok) {
    const alt = await relayInstead(cur, req);
    if (!alt) { await ImageCloud.updateOne({ key: 'main' }, { $set: { lastError: t.message, lastErrorAt: new Date() } }); return; }
    await ImageCloud.updateOne({ key: 'main' }, { $set: { baseUrl: alt.baseUrl } });
    realtime.broadcast('imagecloud.alert', { level: 'warn', message: `☁ ${alt.message}` });
    cur = { ...cur, baseUrl: alt.baseUrl }; t = alt.test;
  }
  await ImageCloud.updateOne({ key: 'main' }, { $set: { enabled: true, nodeName: t.node || '', lastOkAt: new Date(), lastError: '' } });
  imageCloud.invalidate();
  realtime.broadcast('imagecloud.alert', { level: 'ok', message: `✓ فُعّلت سحابة الصور تلقائياً — جهاز ${t.node || 'الكاشير'} يرد على ${cur.baseUrl}` });
}

/**
 * سحابة مفعّلة برابط محلي محفوظ (127.0.0.1 / 192.168.x — لا يصله الخادم أبداً) وجهاز متصل بالنفق
 * ← تتحول للنفق فوراً. (الإصلاح الذاتي كان يعمل قبل التفعيل فقط.)
 */
async function repairEnabled(cur, req) {
  // مفعّلة برابط عام فشل مؤخراً ← هل ما زال لا يرد؟ النفق بدله (مرة كل 20 ثانية على الأكثر)
  if (cur.baseUrl && !relay.isRelayUrl(cur.baseUrl) && !relay.isPrivateUrl(cur.baseUrl) && cur.lastError && req && relay.connectedCount()
    && !(cur.lastAutoTry && Date.now() - new Date(cur.lastAutoTry).getTime() < 20000)) {
    await ImageCloud.updateOne({ key: 'main' }, { $set: { lastAutoTry: new Date() } });
    if ((await imageCloud.test(cur)).ok) return;
    const alt = await relayInstead(cur, req);
    if (!alt) return;
    await ImageCloud.updateOne({ key: 'main' }, { $set: { baseUrl: alt.baseUrl, nodeName: alt.test.node || '', lastOkAt: new Date(), lastError: '' } });
    imageCloud.invalidate();
    realtime.broadcast('imagecloud.alert', { level: 'warn', message: `☁ ${alt.message}` });
    return;
  }
  if (!relay.isPrivateUrl(cur.baseUrl) || !relay.connectedCount() || !req) return;
  const base = relay.baseFor(req);
  if (!base) return;
  await ImageCloud.updateOne({ key: 'main' }, { $set: { baseUrl: base, lastError: '' } });
  imageCloud.invalidate();
  realtime.broadcast('imagecloud.alert', { level: 'ok', message: '✓ سحابة الصور: الرابط المحلي استُبدل بنفق خادم ديار' });
}

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
  try {
    const out = await nodesSvc.heartbeat(req.body || {}, realtime.broadcast);
    if (out.config) {
      out.config.relayUrl = relayWs(req); // جهاز أثبت هويته: عنوان النفق
      out.needKey = await needsKeyFrom(String((req.body || {}).nodeId || ''));
    }
    out.relayConnected = relay.status().some((n) => n.nodeId === String((req.body || {}).nodeId || ''));
    res.json({ success: true, ...out });
  } catch (err) { return fail(res, err); }
  tryAutoEnable(req).catch((e) => console.error('imagecloud auto-enable:', e.message));
};

const nodeRemove = async (req, res) => {
  const id = String(req.params.nodeId || '');
  await nodesSvc.remove(id);
  const cur = await ImageCloud.findOne({ key: 'main' }).lean();
  if (cur && cur.keyNodeId === id) { await ImageCloud.updateOne({ key: 'main' }, { $set: { keyNodeId: '' } }); imageCloud.invalidate(); }
  res.json({ success: true, cloud: await view() });
};

/** DiyarPOS يطلب الربط (أي حساب). مدير النظام على الجهاز نفسه = موافقة فورية. */
const nodeRequest = async (req, res) => {
  try {
    const out = await nodesSvc.request(req.user, req.body || {}, {
      canApprove: hasPermission(req.user, 'images:cloud'),
      onNew: (r) => {
        const who = r.name || r.machine || r.nodeId;
        const message = `جهاز ${who} يطلب ربط سحابة الصور — وافق من الإعدادات ← سحابة الصور`;
        realtime.broadcast('imagecloud.request', { nodeId: r.nodeId, name: who, message });
        pushAdmins('☁ طلب ربط سحابة الصور', `جهاز ${who} يطلب الربط — اضغط للموافقة`);
      },
    });
    // بعد الموافقة: هل يحتاج الجهاز إنشاء مفتاح رفع؟ (لا، إن كانت السحابة تعمل بمفتاح يتزامن لكل الأجهزة)
    if (out.status === 'approved') {
      const cur = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
      out.needKey = !(cur && cur.enabled && cur.apiKey);
    }
    res.json({ success: true, ...out });
  } catch (err) { fail(res, err); }
};

const nodeDecide = async (req, res) => {
  try {
    await nodesSvc.decide(req.user, String(req.params.nodeId || ''), req.body && req.body.approve !== false);
    res.json({ success: true, cloud: await view() });
  } catch (err) { fail(res, err); }
};

/**
 * الجهاز المُوافَق عليه يستلم الأسرار وينضم، ويرسل مفتاح الرفع الذي أنشأه.
 * إن لم تكن السحابة مفعّلة: يُحفظ المفتاح والرابط، ويُختبر الاتصال، وتُفعَّل إن نجح.
 */
const nodeClaim = async (req, res) => {
  const b = req.body || {};
  let out;
  try { out = await nodesSvc.claim(b); } catch (err) { return fail(res, err); }
  const cur = (await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean()) || {};
  const who = (out.request && (out.request.name || out.request.machine)) || out.nodeId;
  const apiKey = typeof b.apiKey === 'string' && KEY_RX.test(b.apiKey.trim()) ? b.apiKey.trim() : '';
  const $set = { linkedFrom: `DiyarPOS — ${who}`, updatedByName: out.approvedBy || '' };
  // مفتاح السحابة العاملة يبقى (المفاتيح تتزامن بين الأجهزة)؛ يُستبدل فقط إن لم تكن مفعّلة
  if (apiKey && (!cur.apiKey || !cur.enabled)) { $set.apiKey = apiKey; $set.keyNodeId = out.nodeId; }
  // بلا رابط عام خاص (Cloudflare…): الصور تمر عبر نفق هذا الخادم تلقائياً
  const usable = (u) => (u && !relay.isPrivateUrl(u) ? u : '');
  const baseUrl = usable(cur.baseUrl) || usable(imageCloud.trimUrl(b.publicUrl || '')) || relay.baseFor(req);
  if (baseUrl !== cur.baseUrl) $set.baseUrl = baseUrl;
  if (!cur.projectId) $set.projectId = String(b.projectId || 'diyar').slice(0, 64);

  let link;
  if (cur.enabled) link = { enabled: true, message: 'سحابة الصور مفعّلة — انضم الجهاز للمزامنة' };
  else if (!baseUrl) link = { enabled: false, message: 'انضم الجهاز للمزامنة — بقي الرابط العام (نفق Cloudflare) ليُفعَّل الرفع: ضعه من لوحة التحكم ← سحابة الصور' };
  else {
    const cfg = { baseUrl, projectId: $set.projectId || cur.projectId, apiKey: $set.apiKey || cur.apiKey, keyNodeId: $set.keyNodeId || cur.keyNodeId || '' };
    let t = cfg.apiKey ? await imageCloud.test(cfg) : { ok: false, message: 'لا يوجد مفتاح رفع' };
    if (!t.ok) {
      const alt = await relayInstead(cfg, req);
      if (alt) { $set.baseUrl = alt.baseUrl; t = alt.test; }
    }
    if (t.ok) {
      Object.assign($set, { enabled: true, nodeName: t.node || '', lastOkAt: new Date(), lastError: '' });
      link = { enabled: true, message: 'فُعّلت سحابة الصور — الصور الجديدة تُرفع إليها الآن' };
    } else {
      Object.assign($set, { lastError: t.message, lastErrorAt: new Date() });
      link = relay.isRelayUrl(baseUrl)
        ? { enabled: false, message: 'انضم الجهاز — الصور تمر عبر خادم ديار، وتُفعَّل السحابة تلقائياً حين يتصل النفق (خلال دقيقة)' }
        : { enabled: false, message: `انضم الجهاز — الرابط العام لا يرد (${t.message})، فتُفعَّل السحابة عبر خادم ديار تلقائياً حين يتصل النفق (خلال دقيقة)` };
    }
  }
  // أول جهاز: يُفعَّل تلقائياً حين يصل الخادم للرابط العام (بعد ضبط النفق من الهاتف)
  if (!cur.enabled && !link.enabled) $set.wantEnabled = true;
  await ImageCloud.updateOne({ key: 'main' }, { $set }, { upsert: true });
  imageCloud.invalidate();
  realtime.broadcast('imagecloud.alert', { level: link.enabled ? 'ok' : 'warn', nodeId: out.nodeId, message: `☁ جهاز ${who}: ${link.message}` });
  delete out.request;
  res.json({ success: true, ...out, link, relayUrl: relayWs(req) });
};

/**
 * يحتاج الخادم مفتاحاً من هذا الجهاز؟ نعم إن لم تكن السحابة مفعّلة، والجهاز متصل بالنفق، و(لا مفتاح،
 * أو صاحب المفتاح جهاز آخر غير متصل — مثل جهاز على شبكة أخرى لا يتزامن معه).
 */
async function needsKeyFrom(nodeId) {
  const cur = await ImageCloud.findOne({ key: 'main' }).select('+apiKey').lean();
  if (!cur || !relay.isConnected(nodeId)) return false;
  // مفعّلة برابط عام خاص (Cloudflare): الرفع لا يمر بالنفق، فلا علاقة لمفتاح هذا الجهاز
  const viaRelay = !cur.baseUrl || relay.isRelayUrl(cur.baseUrl) || relay.isPrivateUrl(cur.baseUrl);
  if (cur.enabled && !viaRelay) return false;
  if (!cur.apiKey) return true;
  // رفض جهاز الصور المفتاح مؤخراً (ساعة): يُطلب من الجهاز المتصل — ولو كان صاحبه (أُبطل وأُنشئ غيره)
  if (cur.keyRejectedAt && Date.now() - new Date(cur.keyRejectedAt).getTime() < 3600000) return true;
  // صاحب المفتاح غير متصل وهذا الجهاز متصل (شبكتان مختلفتان) — مفعّلة كانت أو لا
  return cur.keyNodeId !== nodeId && !relay.isConnected(cur.keyNodeId);
}

/** الجهاز (بسرّه) يرسل مفتاحه حين يطلبه الخادم ← يُحفظ ويُختبر عبر النفق ويُفعَّل. */
const nodeKey = async (req, res) => {
  const b = req.body || {};
  const node = await nodesSvc.proven(b.nodeId, b.proof);
  if (!node) return res.status(403).json({ success: false, message: 'هذا الجهاز غير معروف' });
  const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  if (!KEY_RX.test(apiKey)) return res.status(400).json({ success: false, message: 'صيغة المفتاح غير صحيحة' });
  if (!(await needsKeyFrom(node.nodeId))) return res.status(409).json({ success: false, message: 'لا حاجة لمفتاح من هذا الجهاز' });
  const before = await ImageCloud.findOne({ key: 'main' }).lean();
  if (before && before.enabled) {
    // سحابة تعمل: لا يُستبدل مفتاحها إلا بمفتاح مُختبَر عبر النفق على هذا الجهاز
    const baseUrl = relay.isPrivateUrl(before.baseUrl) || !before.baseUrl ? relay.baseFor(req) : before.baseUrl;
    const t = await imageCloud.test({ baseUrl, apiKey, keyNodeId: node.nodeId });
    if (!t.ok) {
      await ImageCloud.updateOne({ key: 'main' }, { $set: { lastError: `مفتاح جهاز ${node.name || node.nodeId}: ${t.message}`, lastErrorAt: new Date() } });
      return res.json({ success: true, enabled: true, message: t.message });
    }
    await ImageCloud.updateOne({ key: 'main' }, { $set: { apiKey, baseUrl, keyNodeId: node.nodeId, keyRejectedAt: null, nodeName: t.node || '', lastOkAt: new Date(), lastError: '',
      linkedFrom: `DiyarPOS — ${node.name || node.nodeId}` } });
    imageCloud.invalidate();
    realtime.broadcast('imagecloud.alert', { level: 'ok', message: `✓ سحابة الصور: الرفع الآن إلى جهاز ${node.name || node.nodeId} (مفتاحه مُختبَر)` });
    return res.json({ success: true, enabled: true, message: 'سحابة الصور تعمل على هذا الجهاز' });
  }
  await ImageCloud.updateOne({ key: 'main' }, { $set: { apiKey, keyNodeId: node.nodeId, keyRejectedAt: null, wantEnabled: true, linkedFrom: `DiyarPOS — ${node.name || node.nodeId}` } });
  imageCloud.invalidate();
  await tryAutoEnable(req, true);
  const cur = await ImageCloud.findOne({ key: 'main' }).lean();
  res.json({ success: true, enabled: !!(cur && cur.enabled), message: cur && cur.enabled ? 'فُعّلت سحابة الصور' : (cur && cur.lastError) || '' });
};

/** عنوان اتصال الأجهزة بالنفق: wss://{هذا الخادم}/api/image-cloud/relay/ws */
const relayWs = (req) => relay.baseFor(req).replace(/^http/, 'ws') + '/ws';

/** IMAGE-SERVER: تشخيص خطوة بخطوة (مدير النظام) — أين يفشل الاتصال بالضبط، بلا أسرار. */
const diagnose = async (req, res) => {
  const out = await require('../services/imageCloudDiagnose').diagnose({ req });
  res.json({ success: true, diagnosis: out });
};

const relayStatus = async (req, res) => res.json({ success: true, devices: relay.status(), cache: relay.cacheStats() });

module.exports = wrapAll({ get, update, test, migrateStatus, migrateStart, nodeJoin, nodeHeartbeat, nodeRemove, nodeRequest, nodeDecide, nodeClaim, relayStatus, nodeKey, diagnose });
