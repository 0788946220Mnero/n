/**
 * /api/brq/chat — دردشة واحدة للسائقين والمتاجر والإدارة:
 *   • «السائقون والإدارة» (all) و«المتاجر والإدارة» (stores) — مجموعتان عامتان.
 *   • محادثات خاصة بين أي طرفين (سائق/متجر/الإدارة).
 *   • مدير النظام (brq:monitor) مشرف على الكل: يقرأ كل الخاص ويحذف أي رسالة.
 * الصور على سيرفر الصور نفسه (ImageStorage)، والصوت في القاعدة خلف تسجيل الدخول، والإشعارات FCM للسائقين.
 * نفس الراوتر مركّب أيضاً على /api/brq/driver/chat للتوافق.
 */
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const Driver = require('../models/Driver');
const Store = require('../models/Store');
const ChatMessage = require('../models/ChatMessage');
const ChatMedia = require('../models/ChatMedia');
const { resolvePrincipal, bearerToken, SESSION_REPLACED } = require('../auth');
const realtime = require('../realtime');
const push = require('../services/push');
const imageCloud = require('../../services/imageCloudService'); // سيرفر صور ديار نفسه
const { isValidPoint } = require('../geo');
const { GROUPS, keyOf, dmChannel, dmParts, partOf, canRead, canWrite } = require('../chat/channel');

const router = express.Router();
const IMAGE_MAX_BYTES = 1.6 * 1024 * 1024;
const VOICE_MAX_BYTES = 1.5 * 1024 * 1024;
const IMAGE_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMAGE_MAX_BYTES, files: 1 } });
const uploadVoice = multer({ storage: multer.memoryStorage(), limits: { fileSize: VOICE_MAX_BYTES, files: 1 } });
const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ── من يكتب؟ سائق، متجر، أو مستخدم إدارة (نفس مستخدمي ديار) ── */
async function party(req, res, next) {
  const p = await resolvePrincipal(bearerToken(req)).catch(() => null);
  if (p && p.replaced) return res.status(401).json({ success: false, ...SESSION_REPLACED });
  if (!p) return res.status(401).json({ success: false, message: 'انتهت الجلسة، سجّل الدخول مجدداً' });
  if (p.role === 'driver') req.party = { key: keyOf('driver', p.id), kind: 'driver', id: p.id, name: p.doc.name, doc: p.doc };
  else if (p.role === 'store') req.party = { key: keyOf('store', p.id), kind: 'store', id: p.id, name: p.doc.name, doc: p.doc };
  else if (p.role === 'staff') {
    // brq:monitor مشرف على كل المحادثات، و brq:chat يراسل كـ«الإدارة»
    const monitor = p.perms.includes('brq:monitor');
    const admin = monitor || p.perms.includes('brq:chat');
    if (!admin) return res.status(403).json({ success: false, message: 'لا تملك صلاحية الدردشة' });
    req.party = { key: 'admin', kind: 'admin', id: p.id, name: `الإدارة · ${p.doc.name}`, admin: true, monitor, readOnly: p.readOnly };
  } else return res.status(401).json({ success: false, message: 'غير مصرح' });
  if (req.party.readOnly && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({ success: false, message: 'حساب مراقب البيانات للعرض فقط' });
  }
  next();
}
router.use(party);

/* 20 رسالة في الدقيقة لكل طرف */
const sends = new Map();
function tooFast(key) {
  const now = Date.now();
  const list = (sends.get(key) || []).filter((t) => now - t < 60000);
  if (list.length >= 20) { sends.set(key, list); return true; }
  list.push(now); sends.set(key, list);
  return false;
}

const out = (m) => ({
  id: String(m._id), channel: m.channel, kind: m.kind,
  sender: { kind: m.senderKind || 'driver', id: String(m.sender), name: m.senderName },
  text: m.deleted ? '' : m.text,
  image: m.deleted || !m.image || !m.image.url ? null : { url: m.image.url, thumb: m.image.thumb },
  voice: m.deleted || !m.voice || !m.voice.media ? null : { mediaId: String(m.voice.media), duration: m.voice.duration || 0 },
  location: m.deleted || !m.location || !Number.isFinite(m.location.lat) ? null : { lat: m.location.lat, lng: m.location.lng, label: m.location.label || '' },
  deleted: !!m.deleted,
  createdAt: m.createdAt,
});

/** يتأكد أن الطرف الآخر في المحادثة الخاصة موجود ومفعّل. */
async function assertPartiesExist(channel) {
  const parts = dmParts(channel);
  if (!parts) return;
  for (const k of parts) {
    const p = partOf(k);
    if (p.kind === 'driver' && !(await Driver.exists({ _id: p.id, active: true }))) throw httpError(404, 'السائق غير موجود');
    if (p.kind === 'store' && !(await Store.exists({ _id: p.id, active: true }))) throw httpError(404, 'المتجر غير موجود');
  }
}

/** بث لمن يحق له: أعضاء المجموعة أو طرفا الخاص، والإدارة، والمشرف دائماً. */
function broadcast(channel, payload) {
  const group = GROUPS[channel] ? channel : null;
  const parts = group ? [] : (dmParts(channel) || []);
  realtime.toWhere((c) => {
    if (c.role === 'driver') return group === 'all' || parts.includes(`d.${c.id}`);
    if (c.role === 'store') return group === 'stores' || parts.includes(`s.${c.id}`);
    if (c.role === 'staff') return c.chatMonitor || (c.chatParty && (!!group || parts.includes('admin')));
    return false;
  }, payload);
}

async function publish(msg) {
  const channel = msg.channel;
  broadcast(channel, { type: 'chat.message', message: out(msg) });

  // إشعار FCM للسائقين المعنيين غير المتصلين الآن (لا يُرسل للمرسل)
  let query = null;
  if (channel === 'all') query = { active: true };
  else {
    const ids = (dmParts(channel) || []).filter((k) => k.startsWith('d.') && k !== `d.${msg.sender}`).map((k) => k.slice(2));
    if (ids.length) query = { _id: { $in: ids } };
  }
  if (!query) return;
  const recipients = await Driver.find({ ...query, pushTokens: { $exists: true, $ne: [] } }, { pushTokens: 1 }).lean();
  const tokens = recipients
    .filter((d) => !(msg.senderKind === 'driver' && String(d._id) === String(msg.sender)))
    .filter((d) => realtime.countDriverConnections(d._id) === 0)
    .flatMap((d) => d.pushTokens);
  if (!tokens.length) return;
  const title = GROUPS[channel] ? GROUPS[channel].name : `رسالة من ${msg.senderName}`;
  const body = { image: '📷 صورة', voice: '🎤 رسالة صوتية', location: '📍 موقع' }[msg.kind] || msg.text.slice(0, 120);
  const res = await push.sendToTokens(tokens, { title, body, tag: `chat-${channel}`, data: { kind: 'chat', link: './', channel } });
  if (res.invalidTokens.length) {
    await Driver.updateMany({ pushTokens: { $in: res.invalidTokens } }, { $pull: { pushTokens: { $in: res.invalidTokens } } });
  }
}

const senderFields = (req) => ({ senderKind: req.party.kind, sender: String(req.party.id), senderName: req.party.name });

async function guardWrite(req, channel) {
  if (!canWrite(req.party, channel)) throw httpError(403, 'لا تملك صلاحية هذه المحادثة');
  if (tooFast(`${req.party.key}:${req.party.id}`)) throw httpError(429, 'رسائل كثيرة، انتظر قليلاً');
  await assertPartiesExist(channel);
}

/* ─────────── القنوات ─────────── */

/**
 * GET /api/chat/channels
 *   groups   : المجموعات العامة المتاحة لك
 *   contacts : من تستطيع مراسلته خاصاً (الإدارة، السائقون، المتاجر)
 *   recent   : محادثاتك الخاصة الأخيرة (وللمشرف: كل المحادثات الخاصة بين الآخرين أيضاً)
 */
router.get('/channels', async (req, res) => {
  const me = req.party;
  const groups = Object.entries(GROUPS)
    .filter(([ch]) => canRead(me, ch))
    .map(([channel, g]) => ({ channel, name: g.name, kind: 'group' }));

  const now = Date.now();
  const [drivers, stores] = await Promise.all([
    Driver.find({ active: true }).select('name vehicle lastLocation').sort({ name: 1 }).lean(),
    Store.find({ active: true }).select('name').sort({ name: 1 }).lean(),
  ]);
  const names = new Map([['admin', 'الإدارة']]);
  drivers.forEach((d) => names.set(`d.${d._id}`, `🛵 ${d.name}`));
  stores.forEach((s) => names.set(`s.${s._id}`, `🏪 ${s.name}`));

  const myKey = me.kind === 'admin' ? 'admin' : me.key;
  const contacts = [];
  if (me.kind !== 'admin') contacts.push({ channel: dmChannel(myKey, 'admin'), name: 'الإدارة', kind: 'admin' });
  drivers.filter((d) => `d.${d._id}` !== myKey).forEach((d) => contacts.push({
    channel: dmChannel(myKey, `d.${d._id}`), name: d.name, kind: 'driver', sub: d.vehicle || '',
    online: realtime.countDriverConnections(d._id) > 0 || (!!d.lastLocation && !!d.lastLocation.at && now - new Date(d.lastLocation.at).getTime() < 120000),
  }));
  stores.filter((s) => `s.${s._id}` !== myKey).forEach((s) => contacts.push({ channel: dmChannel(myKey, `s.${s._id}`), name: s.name, kind: 'store' }));

  // آخر رسالة لكل محادثة خاصة يقرؤها هذا الطرف
  const esc = (k) => k.replace(/[.|]/g, (c) => `\\${c}`);
  const match = me.monitor ? { channel: { $regex: '^dm:' } } : { channel: { $regex: `^dm:(.*\\|)?${esc(myKey)}(\\|.*)?$` } };
  const rows = await ChatMessage.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$channel', at: { $first: '$createdAt' }, text: { $first: '$text' }, kind: { $first: '$kind' }, from: { $first: '$senderName' } } },
    { $sort: { at: -1 } },
    { $limit: 60 },
  ]);
  const recent = rows.map((r) => {
    const parts = dmParts(r._id) || [];
    const mine = parts.includes(myKey);
    const other = parts.find((k) => k !== myKey);
    return {
      channel: r._id,
      name: mine ? (names.get(other) || 'محادثة') : parts.map((k) => names.get(k) || k).join(' ↔ '),
      supervised: !mine, // للمشرف: محادثة بين طرفين آخرين
      at: r.at, last: r.kind === 'text' ? String(r.text || '').slice(0, 60) : ({ image: '📷 صورة', voice: '🎤 صوت', location: '📍 موقع' }[r.kind] || ''),
      from: r.from,
    };
  });

  res.json({ success: true, me: { kind: me.kind, id: String(me.id), key: myKey, monitor: !!me.monitor }, groups, contacts, recent });
});

/** GET /api/chat/messages?channel=&before= — آخر 50 رسالة */
router.get('/messages', async (req, res) => {
  const channel = String(req.query.channel || '');
  if (!canRead(req.party, channel)) return res.status(403).json({ success: false, message: 'لا تملك صلاحية هذه المحادثة' });
  const filter = { channel };
  if (req.query.before && mongoose.isValidObjectId(req.query.before)) filter._id = { $lt: req.query.before };
  const list = await ChatMessage.find(filter).sort({ _id: -1 }).limit(50).lean();
  res.json({ success: true, messages: list.reverse().map(out) });
});

/** POST /api/chat/messages  { channel, text } أو { channel, location: { lat, lng, label? } } */
router.post('/messages', async (req, res) => {
  try {
    const channel = String(req.body.channel || '');
    const loc = req.body.location;
    const text = String(req.body.text || '').trim();
    let doc;
    if (loc) {
      const point = { lat: Number(loc.lat), lng: Number(loc.lng) };
      if (!isValidPoint(point)) throw httpError(400, 'موقع غير صالح');
      doc = { kind: 'location', location: { ...point, label: String(loc.label || '').trim().slice(0, 80) } };
    } else {
      if (!text) throw httpError(400, 'الرسالة فارغة');
      if (text.length > 1000) throw httpError(400, 'الرسالة طويلة (1000 حرف كحد أقصى)');
      doc = { kind: 'text', text };
    }
    await guardWrite(req, channel);
    const msg = await ChatMessage.create({ channel, ...senderFields(req), ...doc });
    await publish(msg).catch((e) => console.error('chat publish:', e.message));
    res.status(201).json({ success: true, message: out(msg) });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' }); }
});

/** POST /api/chat/image — multipart: file + channel (على سيرفر الصور) */
router.post('/image', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'الصورة كبيرة جداً' : 'تعذّر قراءة الملف' });
  next();
}), async (req, res) => {
  try {
    const channel = String(req.body.channel || '');
    if (!req.file) throw httpError(400, 'لم تصل صورة');
    if (!IMAGE_MIME[req.file.mimetype]) throw httpError(400, 'الصيغة غير مدعومة — jpg أو png أو webp');
    await guardWrite(req, channel);
    let img;
    try {
      const r = await imageCloud.upload(req.file.buffer, { mime: req.file.mimetype, filename: `chat.${IMAGE_MIME[req.file.mimetype]}`, folder: 'alburaq-chat', variant: 'large' });
      img = { id: String(r.id), url: r.url, thumb: String(r.url).replace(/\/large$/, '/medium') };
    } catch (e) {
      throw httpError(503, 'سيرفر الصور غير متاح الآن — ' + (e.message || ''));
    }
    const msg = await ChatMessage.create({ channel, ...senderFields(req), kind: 'image', image: img });
    await publish(msg).catch((e) => console.error('chat publish:', e.message));
    res.status(201).json({ success: true, message: out(msg) });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' }); }
});

/** POST /api/chat/voice — multipart: file (صوت) + channel + duration */
router.post('/voice', (req, res, next) => uploadVoice.single('file')(req, res, (err) => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'الرسالة الصوتية طويلة جداً' : 'تعذّر قراءة الملف' });
  next();
}), async (req, res) => {
  try {
    const channel = String(req.body.channel || '');
    if (!req.file || !String(req.file.mimetype || '').startsWith('audio/')) throw httpError(400, 'لم يصل تسجيل صوتي');
    await guardWrite(req, channel);
    const duration = Math.max(0, Math.min(600, Math.round(Number(req.body.duration) || 0)));
    const media = await ChatMedia.create({ mime: req.file.mimetype, size: req.file.size, data: req.file.buffer, channel, uploader: req.party.key });
    const msg = await ChatMessage.create({ channel, ...senderFields(req), kind: 'voice', voice: { media: media._id, duration, mime: req.file.mimetype } });
    await publish(msg).catch((e) => console.error('chat publish:', e.message));
    res.status(201).json({ success: true, message: out(msg) });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' }); }
});

/** GET /api/chat/media/:id — تشغيل رسالة صوتية (لمن يقرأ المحادثة فقط) */
router.get('/media/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
  const media = await ChatMedia.findById(req.params.id).select('+data');
  if (!media || media.deleted || !media.data) return res.status(404).json({ success: false, message: 'غير موجود' });
  if (!canRead(req.party, media.channel)) return res.status(403).json({ success: false, message: 'لا تملك صلاحية' });
  res.set('Content-Type', media.mime).set('Cache-Control', 'private, max-age=86400').send(media.data);
});

/** DELETE /api/chat/messages/:id — المرسل يحذف رسالته، والمشرف يحذف أي رسالة */
router.delete('/messages/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
  const m0 = await ChatMessage.findById(req.params.id).lean();
  if (!m0 || m0.deleted) return res.status(404).json({ success: false, message: 'الرسالة غير موجودة' });
  const own = m0.senderKind === req.party.kind && String(m0.sender) === String(req.party.id);
  if (!own && !req.party.monitor) return res.status(403).json({ success: false, message: 'تحذف رسائلك فقط' });
  const m = await ChatMessage.findOneAndUpdate(
    { _id: m0._id, deleted: false },
    { $set: { deleted: true, deletedBy: own ? 'sender' : 'monitor', text: '', image: null, location: null } },
    { new: true }
  );
  if (!m) return res.status(404).json({ success: false, message: 'الرسالة غير موجودة' });
  if (m.voice && m.voice.media) await ChatMedia.updateOne({ _id: m.voice.media }, { $set: { deleted: true }, $unset: { data: 1 } });
  broadcast(m.channel, { type: 'chat.message', message: out(m) });
  res.json({ success: true });
});

/** POST /api/chat/push-token  { token } — جهاز السائق أو المتجر لاستقبال الإشعارات */
router.post('/push-token', async (req, res) => {
  if (!['driver', 'store'].includes(req.party.kind)) return res.status(400).json({ success: false, message: 'للسائقين والمتاجر فقط' });
  const token = String(req.body.token || '').trim();
  if (token.length < 20 || token.length > 300) return res.status(400).json({ success: false, message: 'رمز الجهاز غير صالح' });
  const Model = req.party.kind === 'driver' ? Driver : require('../models/Store');
  // آخر 10 أجهزة فقط لكل حساب
  await Model.updateOne({ _id: req.party.id }, { $addToSet: { pushTokens: token } });
  await Model.updateOne({ _id: req.party.id, 'pushTokens.10': { $exists: true } }, { $pop: { pushTokens: -1 } });
  res.json({ success: true });
});

module.exports = { router, out };
