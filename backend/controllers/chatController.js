/*
  دردشة الطاقم — واجهة الخادم.
  chat:use      ← الدردشة (كل الأدوار افتراضياً، ومراقب البيانات أيضاً)
  chat:calls    ← المكالمات الصوتية والمرئية (كل الأدوار افتراضياً)
  chat:monitor  ← مدير النظام: مراجعة كل المحادثات، الحذف، الإعدادات
*/
const mongoose = require('mongoose');
const { wrapAll } = require('../utils/asyncHandler');
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const ChatMedia = require('../models/ChatMedia');
const S = require('../services/chatService');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const bad = (res, message, code = 400, extra = {}) => res.status(code).json({ success: false, message, ...extra });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const me = (req) => String(req.user._id);
const rt = () => require('../services/realtimeService');

async function loadConv(req, res, { member = true } = {}) {
  if (!validId(req.params.id)) { bad(res, 'معرّف غير صالح'); return null; }
  const conv = await ChatConversation.findById(req.params.id).lean();
  if (!conv || conv.deleted) { bad(res, 'المحادثة غير موجودة', 404); return null; }
  const isMem = await S.isMember(conv, req.user);
  if (member ? !isMem : !(isMem || S.canMonitor(req.user))) { bad(res, 'لست عضواً في هذه المحادثة', 403); return null; }
  conv._isMember = isMem;
  return conv;
}
const notifyConv = async (conv, extra = {}) => {
  const ids = await S.memberIds(conv);
  rt().sendToUsers([...ids, ...(extra.also || [])], { type: 'chat.conversation', conversationId: String(conv._id), deleted: !!extra.deleted });
};
const sys = (conv, user, text) => S.post(conv, null, { kind: 'system', text, senderName: '' }).catch(() => null);

/* ═════════ البداية ═════════ */

async function myConversations(user) {
  const all = await S.ensureAll();
  const list = await ChatConversation.find({ $or: [{ members: req_id(user) }, { key: S.ALL }], deleted: { $ne: true } }).sort({ lastAt: -1 }).limit(300).lean();
  if (!list.some((c) => c.key === S.ALL)) list.push(all);
  const users = await S.chatUsers();
  const map = Object.fromEntries(users.map((u) => [u._id, u]));
  const out = [];
  for (const c of list) {
    if (c.type === 'direct' && !c.lastMessage) continue; // محادثة خاصة بلا رسائل لا تظهر بعد
    out.push(await S.summary(c, user, map));
  }
  return out.sort((a, b) => (a.key === S.ALL && !a.lastMessage ? 1 : 0) - (b.key === S.ALL && !b.lastMessage ? 1 : 0) || new Date(b.lastAt) - new Date(a.lastAt));
}
const req_id = (u) => u._id;

// GET /api/chat/bootstrap
const bootstrap = async (req, res) => {
  const users = await S.chatUsers();
  const realtime = rt();
  res.json({
    success: true,
    me: { _id: me(req), name: nameOf(req.user), role: req.user.role },
    users: users.map((u) => ({ ...u, online: realtime.isOnline(u._id) })),
    conversations: await myConversations(req.user),
    settings: await S.settings(),
    canCall: S.can(req.user, 'chat:calls'),
    canMonitor: S.canMonitor(req.user),
    ice: S.iceServers(me(req)),
    pendingCalls: S.pendingFor(me(req)),
  });
};

// GET /api/chat/conversations
const conversations = async (req, res) => res.json({ success: true, conversations: await myConversations(req.user) });

// GET /api/chat/ice — خوادم الاتصال (TURN المؤقت يتجدد)
const ice = async (req, res) => res.json({ success: true, ice: S.iceServers(me(req)), pendingCalls: S.pendingFor(me(req)) });

/* ═════════ المحادثات ═════════ */

// POST /api/chat/conversations/direct { userId }
const openDirect = async (req, res) => {
  const other = String((req.body && req.body.userId) || '');
  if (!validId(other) || other === me(req)) return bad(res, 'اختر زميلاً');
  if (!(await S.chatUsers()).some((u) => u._id === other)) return bad(res, 'هذا المستخدم لا يملك الدردشة');
  const conv = await S.directWith(me(req), other);
  res.json({ success: true, conversation: await S.summary(conv, req.user) });
};

// POST /api/chat/conversations/group { name, members: [] } — أي مستخدم، ومنشئها مشرفها
const createGroup = async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return bad(res, 'اكتب اسم المجموعة');
  const users = await S.chatUsers();
  const ok = new Set(users.map((u) => u._id));
  const members = [...new Set([me(req), ...((req.body && req.body.members) || []).map(String)])].filter((id) => ok.has(id));
  if (members.length < 2) return bad(res, 'اختر عضواً واحداً على الأقل');
  const conv = (await ChatConversation.create({ type: 'group', name, members, admins: [me(req)], createdBy: req.user._id, createdByName: nameOf(req.user) })).toObject();
  await sys(conv, req.user, `أنشأ ${nameOf(req.user)} المجموعة «${name}»`);
  await notifyConv(conv);
  res.status(201).json({ success: true, conversation: await S.summary(await ChatConversation.findById(conv._id).lean(), req.user) });
};

// PATCH /api/chat/conversations/:id { name?, add?, remove?, muted? }
const updateConv = async (req, res) => {
  const conv = await loadConv(req, res, { member: false });
  if (!conv) return null;
  const b = req.body || {};
  const set = {};
  const msgs = [];
  if (b.muted != null) {
    if (!conv._isMember) return bad(res, 'لست عضواً', 403);
    const muted = new Set((conv.muted || []).map(String));
    if (b.muted) muted.add(me(req)); else muted.delete(me(req));
    set.muted = [...muted];
  }
  const manage = b.name != null || b.add || b.remove;
  if (manage) {
    if (conv.type !== 'group' || conv.key === S.ALL) return bad(res, conv.key === S.ALL ? '«كل الطاقم» تلقائية: كل من يملك الدردشة عضو فيها' : 'لا تُعدَّل المحادثة الخاصة');
    const isAdmin = (conv.admins || []).map(String).includes(me(req));
    if (!isAdmin && !S.canMonitor(req.user)) return bad(res, 'مشرف المجموعة فقط يعدّلها', 403);
    const users = await S.chatUsers();
    const byId = Object.fromEntries(users.map((u) => [u._id, u]));
    let members = (conv.members || []).map(String);
    if (b.name != null) {
      const name = String(b.name).trim().slice(0, 60);
      if (!name) return bad(res, 'اسم المجموعة مطلوب');
      if (name !== conv.name) { set.name = name; msgs.push(`غيّر ${nameOf(req.user)} اسم المجموعة إلى «${name}»`); }
    }
    const add = (Array.isArray(b.add) ? b.add : []).map(String).filter((id) => byId[id] && !members.includes(id));
    if (add.length) { members = members.concat(add); msgs.push(`أضاف ${nameOf(req.user)}: ${add.map((id) => byId[id].name).join('، ')}`); }
    const remove = (Array.isArray(b.remove) ? b.remove : []).map(String).filter((id) => members.includes(id) && id !== me(req));
    if (remove.length) { members = members.filter((id) => !remove.includes(id)); msgs.push(`أزال ${nameOf(req.user)}: ${remove.map((id) => (byId[id] ? byId[id].name : 'مستخدم')).join('، ')}`); }
    if (add.length || remove.length) { set.members = members; set.admins = (conv.admins || []).map(String).filter((id) => members.includes(id)); }
    if (remove.length) conv._removed = remove;
  }
  if (!Object.keys(set).length) return res.json({ success: true, conversation: await S.summary(conv, req.user) });
  await ChatConversation.updateOne({ _id: conv._id }, { $set: set });
  const fresh = await ChatConversation.findById(conv._id).lean();
  for (const t of msgs) await sys(fresh, req.user, t);
  if (manage) await notifyConv(fresh, { also: conv._removed || [] });
  res.json({ success: true, conversation: await S.summary(fresh, req.user) });
};

// POST /api/chat/conversations/:id/leave
const leave = async (req, res) => {
  const conv = await loadConv(req, res);
  if (!conv) return null;
  if (conv.type !== 'group' || conv.key === S.ALL) return bad(res, 'لا يمكن مغادرة هذه المحادثة');
  const members = (conv.members || []).map(String).filter((id) => id !== me(req));
  let admins = (conv.admins || []).map(String).filter((id) => id !== me(req));
  if (!admins.length && members.length) admins = [members[0]]; // المجموعة لا تبقى بلا مشرف
  await ChatConversation.updateOne({ _id: conv._id }, { $set: { members, admins } });
  const fresh = await ChatConversation.findById(conv._id).lean();
  await sys(fresh, req.user, `غادر ${nameOf(req.user)} المجموعة`);
  await notifyConv(fresh, { also: [me(req)] });
  res.json({ success: true });
};

// DELETE /api/chat/conversations/:id — مجموعة: مشرفها أو مدير النظام؛ خاصة: مدير النظام (إخفاء لا حذف)
const removeConv = async (req, res) => {
  const conv = await loadConv(req, res, { member: false });
  if (!conv) return null;
  if (conv.key === S.ALL) return bad(res, '«كل الطاقم» لا تُحذف');
  const isAdmin = conv.type === 'group' && (conv.admins || []).map(String).includes(me(req));
  if (!isAdmin && !S.canMonitor(req.user)) return bad(res, conv.type === 'group' ? 'مشرف المجموعة أو مدير النظام فقط' : 'حذف المحادثات الخاصة لمدير النظام', 403);
  await ChatConversation.updateOne({ _id: conv._id }, { $set: { deleted: true, deletedAt: new Date(), deletedByName: nameOf(req.user) } });
  require('../utils/activity').logActivity({ req, action: 'chat.delete', details: { name: conv.name || 'محادثة خاصة', type: conv.type } });
  await notifyConv(conv, { deleted: true });
  res.json({ success: true });
};

/* ═════════ الرسائل ═════════ */

// GET /api/chat/conversations/:id/messages?before=ISO&limit=50 — العضو، أو مدير النظام للمراجعة
const messages = async (req, res) => {
  const conv = await loadConv(req, res, { member: false });
  if (!conv) return null;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const f = { conversation: conv._id };
  if (req.query.before && !isNaN(Date.parse(req.query.before))) f.createdAt = { $lt: new Date(req.query.before) };
  const list = await ChatMessage.find(f).sort({ createdAt: -1 }).limit(limit + 1).lean();
  const more = list.length > limit;
  if (!conv._isMember) {
    // مراجعة مدير النظام: تُسجَّل في سجل النشاط (مرة لكل فتح، لا لكل صفحة)
    if (!req.query.before) require('../utils/activity').logActivity({ req, action: 'chat.monitor', details: { name: conv.name || 'محادثة خاصة', type: conv.type } });
  }
  res.json({ success: true, messages: list.slice(0, limit).reverse().map(S.messageOut), hasMore: more, conversation: await S.summary(conv, req.user), monitoring: !conv._isMember });
};

async function replyOf(conv, id) {
  if (!id || !validId(id)) return null;
  const r = await ChatMessage.findOne({ _id: id, conversation: conv._id }).lean();
  if (!r || r.deleted) return null;
  return { _id: String(r._id), senderName: r.senderName, kind: r.kind, text: S.preview(r).slice(0, 120) };
}

// POST /api/chat/conversations/:id/messages { text, replyTo }
const send = async (req, res) => {
  const conv = await loadConv(req, res);
  if (!conv) return null;
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return bad(res, 'الرسالة فارغة');
  if (text.length > 4000) return bad(res, 'الرسالة طويلة جداً (4000 حرف)');
  const m = await S.post(conv, req.user, { kind: 'text', text, replyTo: await replyOf(conv, req.body && req.body.replyTo) });
  res.status(201).json({ success: true, message: m });
};

/* وسائط: الصورة تُضغط في المتصفح قبل الرفع؛ الصوت كما سجّله الجهاز (webm/ogg على أندرويد وكروم، mp4 على آيفون). */
const LIMITS = { image: 1.6 * 1024 * 1024, voice: 3 * 1024 * 1024 };
function sniff(buf) {
  const h = buf.subarray(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (h.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { kind: 'image', mime: 'image/png' };
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (h.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'voice', mime: 'audio/webm' };
  if (h.subarray(0, 4).toString('latin1') === 'OggS') return { kind: 'voice', mime: 'audio/ogg' };
  if (h.subarray(4, 8).toString('latin1') === 'ftyp') return { kind: 'voice', mime: 'audio/mp4' };
  if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) return { kind: 'voice', mime: 'audio/aac' };
  return null;
}

// POST /api/chat/conversations/:id/media (multipart: file + kind, duration, width, height, text, replyTo)
const sendMedia = async (req, res) => {
  const conv = await loadConv(req, res);
  if (!conv) return null;
  if (!req.file || !req.file.buffer || !req.file.buffer.length) return bad(res, 'لم يُرفق ملف');
  const st = await S.settings();
  const want = req.body.kind === 'voice' ? 'voice' : 'image';
  const t = sniff(req.file.buffer);
  if (!t || t.kind !== want) return bad(res, want === 'voice' ? 'ملف الصوت غير مدعوم' : 'الصورة يجب أن تكون JPG أو PNG أو WebP');
  if (want === 'voice' && !st.voiceEnabled) return bad(res, 'الرسائل الصوتية موقوفة من مدير النظام', 403);
  if (want === 'image' && !st.imagesEnabled) return bad(res, 'إرسال الصور موقوف من مدير النظام', 403);
  if (req.file.buffer.length > LIMITS[want]) return bad(res, want === 'voice' ? 'الرسالة الصوتية كبيرة جداً' : 'الصورة كبيرة جداً — تُضغط تلقائياً، أعد المحاولة');
  const duration = Math.max(0, Math.min(3600, Number(req.body.duration) || 0));
  if (want === 'voice' && duration > st.maxVoiceSec + 2) return bad(res, `أقصى مدة للرسالة الصوتية ${Math.round(st.maxVoiceSec / 60)} دقائق`);
  const media = await ChatMedia.create({ kind: want, mime: t.mime, size: req.file.buffer.length, data: req.file.buffer, conversation: conv._id, uploader: req.user._id });
  const m = await S.post(conv, req.user, {
    kind: want, media: media._id, mediaMime: t.mime, mediaSize: media.size, duration: Math.round(duration * 10) / 10,
    width: Math.max(0, Math.min(10000, parseInt(req.body.width, 10) || 0)), height: Math.max(0, Math.min(10000, parseInt(req.body.height, 10) || 0)),
    text: want === 'image' ? String(req.body.text || '').trim().slice(0, 1000) : '', replyTo: await replyOf(conv, req.body.replyTo),
  });
  res.status(201).json({ success: true, message: m });
};

// GET /api/chat/media/:id — خلف تسجيل الدخول: للأعضاء ولمدير النظام
const media = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const md = await ChatMedia.findById(req.params.id).select('+data').lean();
  if (!md) return bad(res, 'غير موجود', 404);
  const conv = await ChatConversation.findById(md.conversation).lean();
  if (!conv || !((await S.isMember(conv, req.user)) || S.canMonitor(req.user))) return bad(res, 'ليس لديك صلاحية', 403);
  if (md.deleted) return bad(res, 'حُذفت هذه الرسالة', 404);
  if (md.expired || !md.data) return bad(res, 'انتهت مدة الاحتفاظ بهذا الملف', 410);
  const buf = Buffer.isBuffer(md.data) ? md.data : Buffer.from(md.data.buffer || md.data);
  res.set({ 'Content-Type': md.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=604800, immutable' });
  res.end(buf);
};

// POST /api/chat/conversations/:id/read — علامتا القراءة الزرقاوان
const read = async (req, res) => {
  const conv = await loadConv(req, res, { member: false });
  if (!conv) return null;
  if (!conv._isMember) return res.json({ success: true }); // المراجعة لا تُعلِّم الرسائل مقروءة
  const at = new Date().toISOString();
  await ChatConversation.updateOne({ _id: conv._id }, { $set: { [`reads.${me(req)}`]: at } });
  rt().sendToUsers(await S.memberIds(conv), { type: 'chat.read', conversationId: String(conv._id), userId: me(req), at });
  res.json({ success: true, at });
};

// DELETE /api/chat/messages/:id — حذف للجميع: المرسِل، مشرف المجموعة، أو مدير النظام
const deleteMessage = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await ChatMessage.findById(req.params.id).lean();
  if (!m || m.deleted) return bad(res, 'الرسالة غير موجودة', 404);
  const conv = await ChatConversation.findById(m.conversation).lean();
  if (!conv) return bad(res, 'المحادثة غير موجودة', 404);
  const mine = m.sender && String(m.sender) === me(req);
  const groupAdmin = conv.type === 'group' && (conv.admins || []).map(String).includes(me(req));
  if (!mine && !groupAdmin && !S.canMonitor(req.user)) return bad(res, 'تحذف رسائلك أنت فقط', 403);
  if (m.kind === 'call' || m.kind === 'system') return bad(res, 'لا تُحذف رسائل النظام وسجل المكالمات');
  await ChatMessage.updateOne({ _id: m._id }, { $set: { deleted: true, deletedAt: new Date(), deletedByName: nameOf(req.user), text: '', replyTo: null } });
  if (m.media) await ChatMedia.updateOne({ _id: m.media }, { $set: { data: null, deleted: true } });
  if (!mine) require('../utils/activity').logActivity({ req, action: 'chat.message.delete', details: { by: nameOf(req.user), sender: m.senderName } });
  const out = S.messageOut({ ...m, deleted: true, deletedByName: nameOf(req.user), text: '' });
  const members = await S.memberIds(conv);
  rt().sendToUsers(members, { type: 'chat.message.updated', conversationId: String(conv._id), message: out });
  res.json({ success: true, message: out });
};

// GET /api/chat/calls/pending — مكالمة ترنّ لي (عند فتح التطبيق من إشعار الاتصال)
const pendingCalls = async (req, res) => res.json({ success: true, calls: S.pendingFor(me(req)) });

/* ═════════ مدير النظام ═════════ */

// GET /api/chat/admin — كل المحادثات للمراجعة + الإعدادات + الإحصاءات
const admin = async (req, res) => {
  await S.ensureAll();
  const users = await S.chatUsers();
  const byId = Object.fromEntries(users.map((u) => [u._id, u]));
  const convs = await ChatConversation.find({ deleted: { $ne: true } }).sort({ lastAt: -1 }).limit(500).lean();
  const media = await ChatMedia.find({ expired: { $ne: true }, deleted: { $ne: true } }).select('size kind').lean();
  res.json({
    success: true,
    settings: await S.settings(),
    stats: {
      users: users.length,
      conversations: convs.length,
      messages: await ChatMessage.countDocuments({}),
      media: { count: media.length, bytes: media.reduce((t, x) => t + (x.size || 0), 0), voice: media.filter((x) => x.kind === 'voice').length, images: media.filter((x) => x.kind === 'image').length },
    },
    conversations: convs.filter((c) => c.lastMessage || c.key === S.ALL).map((c) => ({
      _id: String(c._id), type: c.type, key: c.key || null,
      name: c.type === 'direct' ? (c.members || []).map((id) => (byId[String(id)] ? byId[String(id)].name : 'مستخدم سابق')).join(' ↔ ') : c.name,
      members: c.key === S.ALL ? users.length : (c.members || []).length, lastMessage: c.lastMessage, lastAt: c.lastAt, createdByName: c.createdByName || '',
    })),
    turn: !!process.env.TURN_URLS,
  });
};

// PUT /api/chat/admin/settings
const adminSettings = async (req, res) => {
  const s = await S.saveSettings(req.body || {});
  require('../utils/activity').logActivity({ req, action: 'chat.settings', details: s });
  rt().sendToUsers(null, { type: 'chat.settings', settings: s }, (c) => (c.perms || []).includes('chat:use'));
  res.json({ success: true, settings: s });
};

module.exports = wrapAll({ bootstrap, conversations, ice, openDirect, createGroup, updateConv, leave, removeConv, messages, send, sendMedia, media, read, deleteMessage, pendingCalls, admin, adminSettings });
module.exports._sniff = sniff;
