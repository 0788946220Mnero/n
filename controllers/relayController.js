/*
  ═══════════════════════════════════════════════════════════════
  الرسول: أوامر المدير من هاتفه إلى جهاز الكاشير.

    POST /api/relay                 المرسل (voice:commands): أمر مؤكَّد ← بث فوري
    POST /api/relay/:id/claim       جهاز مستقبل: استلام ذرّي (جهاز واحد ينفّذ)
    POST /api/relay/:id/done        المستلم: النتيجة ← بث للمرسل
    POST /api/relay/:id/cancel      المرسل: إلغاء إن لم يُستلم بعد (يرجع للتنفيذ على هاتفه)
    GET  /api/relay/:id             المرسل: متابعة النتيجة (استطلاع)
    GET  /api/relay/pending         المستقبل: ما فاته (إن انقطع البث)
    POST /api/relay/receivers/heartbeat   المستقبل: «أنا متصل»
    GET  /api/relay/receivers       المرسل: من المتصل الآن

  التنفيذ على جهاز الكاشير يتم بصلاحيات مستخدمه هو — الخادم يفحص كل عملية.
  الأمر لا يُنفَّذ بعد دقيقتين (جهاز كان مطفأً لا ينفّذ أوامر قديمة).
  ═══════════════════════════════════════════════════════════════
*/
const { wrapAll } = require('../utils/asyncHandler');
const RelayCommand = require('../models/RelayCommand');
const realtime = require('../services/realtimeService');

const TTL_MS = 2 * 60 * 1000;
const RECEIVER_ROLES = ['admin', 'manager', 'cashier'];
const ACTIONS = ['confirm-print', 'set-status', 'drawer', 'platform', 'expense', 'print-expense', 'print-sheet', 'print-invoice', 'announce', 'message'];
const nameOf = (u) => (u && (u.name || u.username)) || '';

// الأجهزة المستقبلة المتصلة (في الذاكرة — يكفي لخادم واحد)
const receivers = new Map(); // deviceId → { deviceId, deviceName, userName, at }
const onlineReceivers = () => {
  const now = Date.now();
  return Array.from(receivers.values()).filter((r) => now - r.at < 45000);
};

const serialize = (c) => ({
  _id: String(c._id), from: String(c.from), fromName: c.fromName, text: c.text, summary: c.summary,
  action: c.action, target: c.target || '', status: c.status, claimedByName: c.claimedByName, device: c.device,
  result: c.result, createdAt: c.createdAt, expiresAt: c.expiresAt,
});

const create = async (req, res) => {
  const action = req.body && req.body.action;
  if (!action || typeof action !== 'object' || !ACTIONS.includes(action.type)) {
    return res.status(400).json({ success: false, message: 'أمر غير معروف' });
  }
  if (JSON.stringify(action).length > 60000) return res.status(400).json({ success: false, message: 'الأمر كبير جداً' });
  const cmd = await RelayCommand.create({
    from: req.user._id, fromName: nameOf(req.user),
    text: String(req.body.text || '').slice(0, 300),
    summary: String(req.body.summary || '').slice(0, 300),
    action, target: String((req.body && req.body.target) || '').slice(0, 64),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  realtime.broadcast('relay.command', { command: serialize(cmd) });
  res.status(201).json({ success: true, command: serialize(cmd), receivers: onlineReceivers().length });
};

const claim = async (req, res) => {
  if (!RECEIVER_ROLES.includes(req.user.role)) return res.status(403).json({ success: false, message: 'هذا الحساب لا يستقبل الأوامر' });
  const cmd = await RelayCommand.findOneAndUpdate(
    // أمر لجهاز محدد لا يستلمه غيره (null: أوامر قديمة بلا الحقل)
    { _id: req.params.id, status: 'queued', expiresAt: { $gt: new Date() }, target: { $in: ['', null, String((req.body && req.body.deviceId) || '').slice(0, 64)] } },
    { $set: { status: 'running', claimedBy: req.user._id, claimedByName: nameOf(req.user), device: String((req.body && req.body.device) || '').slice(0, 60) } },
    { new: true }
  );
  if (!cmd) return res.status(409).json({ success: false, message: 'استُلم الأمر على جهاز آخر أو انتهت مدته' });
  realtime.broadcast('relay.claimed', { command: serialize(cmd) });
  res.json({ success: true, command: serialize(cmd) });
};

const done = async (req, res) => {
  const status = req.body && req.body.status === 'failed' ? 'failed' : 'done';
  const cmd = await RelayCommand.findOneAndUpdate(
    { _id: req.params.id, status: 'running', claimedBy: req.user._id },
    { $set: { status, result: String((req.body && req.body.result) || '').slice(0, 500), doneAt: new Date() } },
    { new: true }
  );
  if (!cmd) return res.status(404).json({ success: false, message: 'الأمر غير موجود أو ليس مستلَماً على هذا الجهاز' });
  realtime.broadcast('relay.done', { command: serialize(cmd) });
  res.json({ success: true, command: serialize(cmd) });
};

const cancel = async (req, res) => {
  const cmd = await RelayCommand.findOneAndUpdate(
    { _id: req.params.id, from: req.user._id, status: 'queued' },
    { $set: { status: 'cancelled', doneAt: new Date() } },
    { new: true }
  );
  if (!cmd) {
    const cur = await RelayCommand.findById(req.params.id).lean();
    return res.status(409).json({ success: false, message: 'استُلم الأمر بالفعل', command: cur ? serialize(cur) : null });
  }
  res.json({ success: true, command: serialize(cmd) });
};

const getOne = async (req, res) => {
  const cmd = await RelayCommand.findById(req.params.id).lean();
  if (!cmd || (String(cmd.from) !== String(req.user._id) && String(cmd.claimedBy) !== String(req.user._id))) {
    return res.status(404).json({ success: false, message: 'الأمر غير موجود' });
  }
  if (cmd.status === 'queued' && new Date(cmd.expiresAt) < new Date()) cmd.status = 'expired';
  res.json({ success: true, command: serialize(cmd) });
};

const pending = async (req, res) => {
  if (!RECEIVER_ROLES.includes(req.user.role)) return res.json({ success: true, data: [] });
  const list = await RelayCommand.find({ status: 'queued', expiresAt: { $gt: new Date() } }).sort({ createdAt: 1 }).limit(20).lean();
  res.json({ success: true, data: list.map(serialize) });
};

const heartbeat = async (req, res) => {
  if (!RECEIVER_ROLES.includes(req.user.role)) return res.status(403).json({ success: false });
  const deviceId = String((req.body && req.body.deviceId) || '').slice(0, 64);
  if (!deviceId) return res.status(400).json({ success: false });
  if (req.body && req.body.off) receivers.delete(deviceId);
  else receivers.set(deviceId, { deviceId, deviceName: String(req.body.deviceName || '').slice(0, 40), userName: nameOf(req.user), role: req.user.role, at: Date.now() });
  res.json({ success: true });
};

const listReceivers = async (req, res) => {
  res.json({ success: true, data: onlineReceivers().map(({ deviceId, deviceName, userName, role, at }) => ({ deviceId, deviceName, userName, role, seenAgo: Date.now() - at })) });
};

module.exports = wrapAll({ create, claim, done, cancel, getOne, pending, heartbeat, listReceivers });
module.exports._receivers = receivers;
