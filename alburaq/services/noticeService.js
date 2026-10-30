/**
 * تنبيهات الإدارة للسائقين والمتاجر: حفظ ← بث لحظي للمفتوح ← إشعار جوال للجميع (FCM).
 */
const Notice = require('../models/Notice');
const Driver = require('../models/Driver');
const Store = require('../models/Store');
const realtime = require('../realtime');
const push = require('./push');

const publicNotice = (n) => ({ id: String(n._id), title: n.title, body: n.body, urgent: !!n.urgent, at: n.createdAt, byName: n.byName || 'إدارة البراق' });

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** التنبيهات التي تخص سائقاً أو متجراً (الأحدث أولاً). */
async function listFor(kind, id, limit = 30) {
  const list = await Notice.find({
    $or: [
      { audience: 'all' }, { audience: kind === 'driver' ? 'drivers' : 'stores' },
      { audience: 'some', recipients: { $elemMatch: { kind, id } } },
    ],
  }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 30, 100)).lean();
  return list.map(publicNotice);
}

/**
 * إرسال تنبيه. input: { audience, recipients?, title, body, urgent, onlyAvailable? }
 */
async function send(input, by = {}) {
  const title = String(input.title || '').trim().slice(0, 80);
  const body = String(input.body || '').trim().slice(0, 600);
  if (!title) throw httpError(400, 'اكتب عنوان التنبيه');
  const audience = ['drivers', 'stores', 'all', 'some'].includes(input.audience) ? input.audience : null;
  if (!audience) throw httpError(400, 'اختر لمن يُرسل التنبيه');
  const recipients = audience === 'some'
    ? (Array.isArray(input.recipients) ? input.recipients : [])
      .filter((r) => r && ['driver', 'store'].includes(r.kind) && /^[a-f0-9]{24}$/i.test(String(r.id)))
      .slice(0, 500).map((r) => ({ kind: r.kind, id: String(r.id) }))
    : [];
  if (audience === 'some' && !recipients.length) throw httpError(400, 'اختر سائقاً أو متجراً واحداً على الأقل');

  // من سيستلم فعلاً
  const driverQ = { active: { $ne: false } };
  if (input.onlyAvailable) driverQ.status = { $ne: 'offline' };
  const drivers = audience === 'drivers' || audience === 'all'
    ? await Driver.find(driverQ, { pushTokens: 1 }).lean()
    : audience === 'some' ? await Driver.find({ _id: { $in: recipients.filter((r) => r.kind === 'driver').map((r) => r.id) } }, { pushTokens: 1 }).lean() : [];
  const stores = audience === 'stores' || audience === 'all'
    ? await Store.find({ active: { $ne: false } }, { pushTokens: 1 }).lean()
    : audience === 'some' ? await Store.find({ _id: { $in: recipients.filter((r) => r.kind === 'store').map((r) => r.id) } }, { pushTokens: 1 }).lean() : [];
  if (!drivers.length && !stores.length) throw httpError(400, 'لا يوجد من يستلم هذا التنبيه');

  // في «لمن هو متاح فقط» يُحفظ كأشخاص بعينهم حتى لا يظهر لمن كان خارج الخدمة
  const saveAudience = input.onlyAvailable && audience === 'drivers' ? 'some' : audience;
  const saveRecipients = saveAudience === 'some' && audience !== 'some' ? drivers.map((d) => ({ kind: 'driver', id: d._id })) : recipients;
  const n = await Notice.create({ audience: saveAudience, recipients: saveRecipients, title, body, urgent: !!input.urgent, by: by.id || null, byName: by.name || '' });
  const msg = { type: 'notice', notice: publicNotice(n) };

  const dIds = new Set(drivers.map((d) => String(d._id)));
  const sIds = new Set(stores.map((s) => String(s._id)));
  let online = 0;
  realtime.toWhere((c) => {
    const hit = (c.role === 'driver' && dIds.has(c.id)) || (c.role === 'store' && sIds.has(c.id));
    if (hit) online++;
    return hit;
  }, msg);

  const message = { title: `📣 ${title}`, body: body || 'تنبيه من إدارة البراق', urgent: !!input.urgent, tag: 'notice-' + n._id, data: { kind: 'notice', noticeId: String(n._id), speak: input.urgent ? 'تنبيه عاجل من الإدارة' : '' } };
  const dTokens = drivers.flatMap((d) => d.pushTokens || []);
  const sTokens = stores.flatMap((s) => s.pushTokens || []);
  const [dr, sr] = await Promise.all([
    push.sendToTokens(dTokens, { ...message, data: { ...message.data, link: './?as=driver' } }),
    push.sendToTokens(sTokens, { ...message, data: { ...message.data, link: './?as=store' } }),
  ]);
  if (dr.invalidTokens.length) await Driver.updateMany({ pushTokens: { $in: dr.invalidTokens } }, { $pull: { pushTokens: { $in: dr.invalidTokens } } });
  if (sr.invalidTokens.length) await Store.updateMany({ pushTokens: { $in: sr.invalidTokens } }, { $pull: { pushTokens: { $in: sr.invalidTokens } } });

  const reached = { online, push: dr.sent + sr.sent, total: drivers.length + stores.length };
  await Notice.updateOne({ _id: n._id }, { $set: { reached } });
  return { notice: { ...publicNotice(n), audience: saveAudience, reached }, reached };
}

async function history(limit = 50) {
  const list = await Notice.find().sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).lean();
  return list.map((n) => ({ ...publicNotice(n), audience: n.audience, count: (n.recipients || []).length, reached: n.reached || {} }));
}

module.exports = { send, listFor, history, publicNotice };
