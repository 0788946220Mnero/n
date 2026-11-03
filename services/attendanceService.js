/*
 * الدوام — حضور وانصراف الموظفين على جهاز واحد في المطعم، والبريك من مسؤول القسم.
 *
 * طبقات منع «التسجيل عن غيره»:
 *   1) جهاز حضور موثوق: مفتاح سري يُربط برمز مؤقت من المدير (لا يمكن التسجيل من جوال الموظف).
 *   2) شبكة المطعم: إن ضُبطت العناوين المسموحة يُرفض أي تسجيل من خارجها.
 *   3) رمز PIN شخصي (bcrypt) يُقفل 5 دقائق بعد 3 محاولات خاطئة، ويُغيَّر دورياً.
 *   4) صورة لحظية مع كل تسجيل — يراها المدير عند المراجعة.
 *   5) فحوصات تلقائية (تأخير، دوام قصير، استراحة طويلة، نسي الانصراف، تعديل يدوي) ← «استثناءات» للمدير.
 * الحسابات: ساعات العمل = (الانصراف − الحضور) − مجموع البريك، واليوم = تاريخ الحضور بتوقيت عمّان.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const AttendanceShift = require('../models/AttendanceShift');
const AttendancePhoto = require('../models/AttendancePhoto');
const AttendanceDevice = require('../models/AttendanceDevice');
const AttendanceConfig = require('../models/AttendanceConfig');
const { hasPermission } = require('../middlewares/permission');
const { logActivity } = require('../utils/activity');
const { ammanNow } = require('./workHours');

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const nameOf = (u) => (u && (u.name || u.username)) || '';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MIN = 60 * 1000;
const PIN_TRIES = 3;
const PIN_LOCK_MS = 5 * MIN;
const PUNCH_GAP_MS = 60 * 1000;

let realtime = null;
const emit = (payload) => {
  try { realtime = realtime || require('./realtimeService'); realtime.broadcast('attendance.changed', payload || {}); } catch (_) {}
};

/* ═══ الوقت بتوقيت عمّان ═══ */
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' });
const ammanDay = (d = new Date()) => dayFmt.format(d);
const dayStart = (ymd) => new Date(`${ymd}T00:00:00+03:00`);
const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const monthRange = (d = new Date()) => { const t = ammanDay(d); return { from: `${t.slice(0, 7)}-01`, to: t }; };
const mins = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / MIN));
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/* ═══ الشبكة ═══ */
const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();
const ip4 = (ip) => { const p = String(ip).split('.').map(Number); return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; };
function ipAllowed(ip, list) {
  if (!Array.isArray(list) || !list.length) return true;
  const n = normIp(ip);
  return list.some((rule) => {
    const r = String(rule || '').trim();
    if (!r) return false;
    if (!r.includes('/')) return normIp(r) === n;
    const [base, bits] = r.split('/');
    const b = Number(bits); const a = ip4(n); const c = ip4(base);
    if (a === null || c === null || !(b >= 0 && b <= 32)) return false;
    const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
    return ((a & mask) >>> 0) === ((c & mask) >>> 0);
  });
}
const cleanIps = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,]+/))
  .map((x) => String(x).trim()).filter((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x)))].slice(0, 20);

/* ═══ الإعدادات ═══ */
async function getConfig() {
  const c = await AttendanceConfig.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  // rev 2: حد «الدوام المفتوح» صار 11 ساعة (كان 14) — مرة واحدة للإعدادات المحفوظة بالقيمة القديمة الافتراضية
  if (!(c.rev >= 2)) {
    const set = { rev: 2 }; if (c.maxShiftHours === 14) set.maxShiftHours = 11;
    await AttendanceConfig.updateOne({ _id: c._id }, { $set: set });
    Object.assign(c, set);
  }
  return c;
}
const publicConfig = (c) => ({
  allowedIps: c.allowedIps || [], requirePhoto: c.requirePhoto !== false, lateGraceMin: c.lateGraceMin, longBreakMin: c.longBreakMin,
  maxShiftHours: c.maxShiftHours, pinMaxDays: c.pinMaxDays, photoDays: c.photoDays,
  supervisors: (c.supervisors || []).map((s) => ({ user: String(s.user), userName: s.userName || '', sections: s.sections || [] })),
});
async function updateConfig(body, user) {
  const b = body || {};
  const set = {};
  const num = (k, lo, hi) => { if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw httpError(400, 'قيمة غير صحيحة'); set[k] = Math.round(v); } };
  if (b.allowedIps !== undefined) set.allowedIps = cleanIps(b.allowedIps);
  if (b.requirePhoto !== undefined) set.requirePhoto = !!b.requirePhoto;
  num('lateGraceMin', 0, 180); num('longBreakMin', 1, 600); num('maxShiftHours', 1, 48); num('pinMaxDays', 0, 3650); num('photoDays', 1, 365);
  if (b.supervisors !== undefined) {
    const User = require('../models/User');
    const rows = (Array.isArray(b.supervisors) ? b.supervisors : []).filter((s) => s && isId(s.user)).slice(0, 50);
    const users = await User.find({ _id: { $in: rows.map((s) => s.user) } }).select('name username').lean();
    set.supervisors = rows.map((s) => {
      const u = users.find((x) => String(x._id) === String(s.user));
      return u ? { user: u._id, userName: nameOf(u), sections: [...new Set((s.sections || []).map((x) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 20) } : null;
    }).filter(Boolean);
  }
  const c = await AttendanceConfig.findOneAndUpdate({ key: 'main' }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  logActivity({ user, action: 'attendance.config', details: { fields: Object.keys(set) } });
  return publicConfig(c);
}

/** نطاق المستخدم: null = كل الأقسام، أو قائمة أقسام مسؤول القسم. */
function scopeFor(user, cfg) {
  if (!user || user.role === 'admin' || user.role === 'manager' || hasPermission(user, 'attendance:manage')) return null;
  const row = (cfg.supervisors || []).find((s) => String(s.user) === String(user._id));
  return row && row.sections && row.sections.length ? row.sections : null;
}

/**
 * ماذا يستطيع المستخدم في الدوام:
 *   breaks: تسجيل الاستراحات — مدير النظام، أي «مدير»، من له الصلاحية، وأي مستخدم أضافه المدير «مسؤول قسم» في الإعدادات
 *   manage: الأجهزة والرموز والاستثناءات والتعديل والعطل · view: التقارير
 *   payments: يرى الراتب وسندات الصرف · settle: يصفّي الموظف
 */
function accessOf(user, cfg) {
  if (!user) return { breaks: false, manage: false, view: false, payments: false, settle: false, scope: null };
  const admin = user.role === 'admin';
  const manage = admin || hasPermission(user, 'attendance:manage');
  const listed = (cfg.supervisors || []).some((s) => String(s.user) === String(user._id));
  const breaks = manage || user.role === 'manager' || hasPermission(user, 'attendance:breaks') || listed;
  const payments = admin || ['employees:manage', 'employees:pay', 'employees:view'].some((k) => hasPermission(user, k));
  const view = breaks || hasPermission(user, 'attendance:view') || payments;
  const settle = admin || (manage && (hasPermission(user, 'employees:manage') || hasPermission(user, 'employees:pay')));
  return { breaks, manage, view, payments, settle, scope: scopeFor(user, cfg) };
}
async function access(user) { return accessOf(user, await getConfig()); }
const inScope = (scope, section) => !scope || scope.includes(section || '');

/* ═══ رمز PIN ═══ */
function weakPin(pin) {
  if (!/^\d{4,6}$/.test(pin)) return 'الرمز من 4 إلى 6 أرقام';
  if (/^(\d)\1+$/.test(pin)) return 'لا تكرر نفس الرقم';
  const d = pin.split('').map(Number);
  const step = d[1] - d[0];
  if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return 'لا تستعمل أرقاماً متسلسلة';
  return '';
}
function randomPin() {
  for (;;) { const p = String(crypto.randomInt(0, 10000)).padStart(4, '0'); if (!weakPin(p)) return p; }
}

async function setPin(employeeId, pin, user) {
  if (!isId(employeeId)) throw httpError(400, 'موظف غير صالح');
  const p = pin ? String(pin).trim() : randomPin();
  const why = weakPin(p);
  if (why) throw httpError(400, why);
  const emp = await Employee.findById(employeeId).select('+pinHash');
  if (!emp) throw httpError(404, 'الموظف غير موجود');
  emp.pinPrevHash = emp.pinHash || '';
  emp.pinHash = await bcrypt.hash(p, 10);
  emp.pinSetAt = new Date(); emp.pinMustChange = true; emp.pinFails = 0; emp.pinLockedUntil = null;
  await emp.save();
  logActivity({ user, action: 'attendance.pin_set', details: { employee: emp.name } });
  return { pin: p, employee: emp.name };
}

async function unlockPin(employeeId, user) {
  if (!isId(employeeId)) throw httpError(400, 'موظف غير صالح');
  const emp = await Employee.findByIdAndUpdate(employeeId, { $set: { pinFails: 0, pinLockedUntil: null } }, { new: true });
  if (!emp) throw httpError(404, 'الموظف غير موجود');
  logActivity({ user, action: 'attendance.pin_unlock', details: { employee: emp.name } });
}

/** يتحقق من الرمز ويقفل بعد 3 محاولات. يرجع الموظف (مع pinHash). */
async function checkPin(employeeId, pin, ctx) {
  if (!isId(employeeId)) throw httpError(400, 'موظف غير صالح');
  const emp = await Employee.findById(employeeId).select('+pinHash +pinPrevHash');
  if (!emp || !emp.active) throw httpError(404, 'الموظف غير موجود أو موقوف');
  if (!emp.pinHash) throw httpError(400, 'لم يُعيَّن لك رمز دوام — اطلبه من المدير');
  if (emp.pinLockedUntil && emp.pinLockedUntil > new Date()) {
    throw httpError(423, `الرمز مقفل بسبب محاولات خاطئة — حاول بعد ${Math.ceil((emp.pinLockedUntil - Date.now()) / MIN)} دقيقة أو اطلب من المدير فتحه`);
  }
  const ok = await bcrypt.compare(String(pin || ''), emp.pinHash);
  if (!ok) {
    const after = await Employee.findByIdAndUpdate(emp._id, { $inc: { pinFails: 1 } }, { new: true });
    if (after.pinFails >= PIN_TRIES) {
      await Employee.updateOne({ _id: emp._id }, { $set: { pinFails: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) } });
      logActivity({ req: ctx && ctx.req, action: 'attendance.pin_locked', details: { employee: emp.name, employeeId: String(emp._id), device: ctx && ctx.device } });
      emit({ employee: String(emp._id), kind: 'locked' });
      throw httpError(423, 'رمز خاطئ — قُفل الرمز 5 دقائق');
    }
    throw httpError(401, `رمز خاطئ — بقي ${PIN_TRIES - after.pinFails} محاولة`);
  }
  if (emp.pinFails) await Employee.updateOne({ _id: emp._id }, { $set: { pinFails: 0 } });
  return emp;
}

async function changePin({ employeeId, pin, newPin }, ctx) {
  const emp = await checkPin(employeeId, pin, ctx);
  const n = String(newPin || '').trim();
  const why = weakPin(n);
  if (why) throw httpError(400, why);
  if (await bcrypt.compare(n, emp.pinHash)) throw httpError(400, 'اختر رمزاً جديداً غير الحالي');
  if (emp.pinPrevHash && await bcrypt.compare(n, emp.pinPrevHash)) throw httpError(400, 'لا تعد لرمز سابق');
  await Employee.updateOne({ _id: emp._id }, { $set: { pinPrevHash: emp.pinHash, pinHash: await bcrypt.hash(n, 10), pinSetAt: new Date(), pinMustChange: false } });
  logActivity({ req: ctx && ctx.req, action: 'attendance.pin_changed', details: { employee: emp.name, device: ctx && ctx.device } });
  return { ok: true };
}
const pinNeedsChange = (emp, cfg) => !!emp.pinMustChange || (cfg.pinMaxDays > 0 && (!emp.pinSetAt || Date.now() - emp.pinSetAt > cfg.pinMaxDays * 864e5));

/* ═══ أجهزة الحضور ═══ */
const publicDevice = (d) => ({
  id: String(d._id), name: d.name, active: d.active, paired: !!d.tokenHash, pairedAt: d.pairedAt,
  pairPending: !!(d.pairCodeHash && d.pairExpiresAt && d.pairExpiresAt > new Date()), pairExpiresAt: d.pairExpiresAt,
  lastIp: d.lastIp || '', lastSeenAt: d.lastSeenAt, createdByName: d.createdByName || '',
});
const newPairCode = () => String(crypto.randomInt(0, 1e8)).padStart(8, '0');

async function listDevices() {
  return (await AttendanceDevice.find({ active: true }).sort({ createdAt: 1 }).lean()).map(publicDevice);
}
async function createDevice(body, user) {
  const name = String((body && body.name) || '').trim().slice(0, 40) || 'جهاز الحضور';
  const code = newPairCode();
  const d = await AttendanceDevice.create({ name, pairCodeHash: sha(code), pairExpiresAt: new Date(Date.now() + 15 * MIN), createdByName: nameOf(user) });
  logActivity({ user, action: 'attendance.device_add', details: { name } });
  return { device: publicDevice(d), code };
}
/** رمز ربط جديد لجهاز موجود (يقطع المفتاح القديم فوراً). */
async function repairDevice(id, user) {
  if (!isId(id)) throw httpError(400, 'جهاز غير صالح');
  const code = newPairCode();
  const d = await AttendanceDevice.findOneAndUpdate({ _id: id, active: true }, { $set: { tokenHash: '', pairCodeHash: sha(code), pairExpiresAt: new Date(Date.now() + 15 * MIN) } }, { new: true });
  if (!d) throw httpError(404, 'الجهاز غير موجود');
  logActivity({ user, action: 'attendance.device_repair', details: { name: d.name } });
  return { device: publicDevice(d), code };
}
async function revokeDevice(id, user) {
  if (!isId(id)) throw httpError(400, 'جهاز غير صالح');
  const d = await AttendanceDevice.findOneAndUpdate({ _id: id, active: true }, { $set: { active: false, tokenHash: '', pairCodeHash: '', revokedAt: new Date(), revokedByName: nameOf(user) } });
  if (!d) throw httpError(404, 'الجهاز غير موجود');
  logActivity({ user, action: 'attendance.device_revoke', details: { name: d.name } });
}
async function pairDevice(code, ip) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 8) throw httpError(400, 'رمز الربط من 8 أرقام');
  const cfg = await getConfig();
  if (!ipAllowed(ip, cfg.allowedIps)) throw httpError(403, 'هذا الجهاز خارج شبكة المطعم');
  const token = crypto.randomBytes(32).toString('base64url');
  const d = await AttendanceDevice.findOneAndUpdate(
    { pairCodeHash: sha(c), pairExpiresAt: { $gt: new Date() }, active: true },
    { $set: { tokenHash: sha(token), pairCodeHash: '', pairExpiresAt: null, pairedAt: new Date(), lastIp: normIp(ip), lastSeenAt: new Date() } },
    { new: true }
  );
  if (!d) throw httpError(400, 'رمز الربط غير صحيح أو انتهت صلاحيته');
  logActivity({ action: 'attendance.device_paired', details: { name: d.name, ip: normIp(ip) } });
  return { token, device: { name: d.name } };
}
/** وسيط جهاز الحضور: المفتاح + شبكة المطعم. */
async function kioskAuth(req, res, next) {
  try {
    const token = String(req.headers['x-kiosk-token'] || '');
    if (token.length < 20) return res.status(401).json({ success: false, code: 'KIOSK_UNPAIRED', message: 'الجهاز غير مربوط' });
    const d = await AttendanceDevice.findOne({ tokenHash: sha(token), active: true }).lean();
    if (!d) return res.status(401).json({ success: false, code: 'KIOSK_UNPAIRED', message: 'الجهاز غير مربوط أو أُلغي' });
    const cfg = await getConfig();
    const ip = normIp(req.ip);
    if (!ipAllowed(ip, cfg.allowedIps)) return res.status(403).json({ success: false, code: 'KIOSK_NETWORK', message: 'هذا الجهاز خارج شبكة المطعم — التسجيل من شبكة المطعم فقط' });
    if (d.lastIp !== ip || !d.lastSeenAt || Date.now() - d.lastSeenAt > MIN) {
      AttendanceDevice.updateOne({ _id: d._id }, { $set: { lastIp: ip, lastSeenAt: new Date() } }).catch(() => {});
    }
    req.kiosk = d; req.attCfg = cfg;
    next();
  } catch (e) { next(e); }
}

/* ═══ الحسابات ═══ */
const bmin = (b, now = new Date()) => (b.endAt ? (b.minutes || mins(b.startAt, b.endAt)) : mins(b.startAt, now));
function breakTotals(breaks, now = new Date()) {
  let minutes = 0; let open = null;
  (breaks || []).forEach((b) => { if (!b.endAt) open = b; minutes += bmin(b, now); });
  return { minutes, count: (breaks || []).length, open };
}
function liveWorked(s, now = new Date()) {
  if (s.status === 'closed') return s.workedMinutes || 0;
  return Math.max(0, mins(s.clockInAt, now) - breakTotals(s.breaks, now).minutes);
}
function lateOf(emp, at, cfg) {
  const st = toMin(emp.shiftStart);
  if (st === null) return 0;
  let diff = ammanNow(at).minutes - st;
  if (diff < -720) diff += 1440; if (diff > 720) diff -= 1440;
  return diff > (cfg.lateGraceMin || 0) ? diff : 0;
}
/** يغلق الدوام عند وقت محدد: ينهي البريك المفتوح ويحسب الساعات والملاحظات. */
function finalize(shift, at, emp, cfg) {
  const breaks = (shift.breaks || []).map((b) => {
    const o = b.toObject ? b.toObject() : { ...b };
    if (!o.endAt) { o.endAt = at; o.minutes = mins(o.startAt, at); o.endedByName = o.endedByName || 'الانصراف'; }
    else o.minutes = bmin(o);
    return o;
  });
  const bm = breaks.reduce((a, b) => a + (b.minutes || 0), 0);
  const total = mins(shift.clockInAt, at);
  const worked = Math.max(0, total - bm);
  const flags = new Set(shift.flags || []);
  if (total < 15) flags.add('short');
  if (emp && emp.shiftHours > 0 && worked > emp.shiftHours * 60 + 30) flags.add('overtime');
  if (breaks.some((b) => b.minutes > (cfg.longBreakMin || 30))) flags.add('long_break');
  return { breaks, breakMinutes: bm, workedMinutes: worked, flags: [...flags] };
}

const FLAG_LABELS = {
  late: 'تأخير', short: 'دوام قصير', overtime: 'إضافي', long_break: 'استراحة طويلة', forgot_out: 'لم يسجّل انصرافاً',
  manual: 'تعديل يدوي', no_photo: 'بلا صورة', closed_by_manager: 'أغلقه المدير', half_day: 'نصف دوام', day_off: 'عطلة',
};
const DAY_LABELS = { work: 'دوام', half: 'نصف دوام', off: 'عطلة' };
/** نصف دوام = نصف ساعات الموظف المحددة (أو 4 ساعات إن لم تُحدد). */
const halfMinutes = (emp) => (emp && emp.shiftHours > 0 ? Math.round(emp.shiftHours * 30) : 240);
function liveFlags(s, cfg, now = new Date()) {
  const f = new Set(s.flags || []);
  if (s.status === 'open' && now - s.clockInAt > (cfg.maxShiftHours || 11) * 3600e3) f.add('forgot_out');
  if (s.status === 'open' && breakTotals(s.breaks, now).open && mins(breakTotals(s.breaks, now).open.startAt, now) > (cfg.longBreakMin || 30)) f.add('long_break');
  return [...f];
}

function publicShift(s, cfg, { photos = false } = {}) {
  const now = new Date();
  const bt = breakTotals(s.breaks, now);
  return {
    id: String(s._id), employee: String(s.employee), employeeName: s.employeeName, section: s.section || '', workDay: s.workDay,
    status: s.status, clockInAt: s.clockInAt, clockOutAt: s.clockOutAt, inDevice: s.inDevice, outDevice: s.outDevice,
    workedMinutes: liveWorked(s, now), breakMinutes: s.status === 'closed' ? s.breakMinutes || 0 : bt.minutes, breakCount: bt.count,
    onBreak: bt.open ? { id: String(bt.open._id), startAt: bt.open.startAt, byName: bt.open.byName, note: bt.open.note } : null,
    breaks: (s.breaks || []).map((b) => ({ id: String(b._id), startAt: b.startAt, endAt: b.endAt, minutes: bmin(b, now), note: b.note, manual: !!b.manual, byName: b.byName, by: b.by ? String(b.by) : '', endedByName: b.endedByName })),
    lateMinutes: s.lateMinutes || 0, flags: liveFlags(s, cfg, now), closedByName: s.closedByName || '',
    dayType: s.dayType || 'work', settled: !!s.settlement, longOpen: s.status === 'open' && now - s.clockInAt > (cfg.maxShiftHours || 11) * 3600e3,
    reviewedAt: s.reviewedAt, reviewedByName: s.reviewedByName || '', reviewNote: s.reviewNote || '', edits: s.edits || [],
    ...(photos ? { inPhoto: s.inPhoto ? String(s.inPhoto) : '', outPhoto: s.outPhoto ? String(s.outPhoto) : '' } : {}),
  };
}

/* ═══ جهاز الحضور ═══ */
async function kioskState(cfg) {
  const [emps, open] = await Promise.all([
    Employee.find({ active: true }).select('+pinHash').sort({ section: 1, name: 1 }).lean(),
    AttendanceShift.find({ status: 'open' }).select('employee clockInAt breaks').lean(),
  ]);
  const byEmp = new Map(open.map((s) => [String(s.employee), s]));
  return {
    requirePhoto: cfg.requirePhoto !== false,
    employees: emps.map((e) => {
      const s = byEmp.get(String(e._id));
      const ob = s && breakTotals(s.breaks).open;
      return { id: String(e._id), name: e.name, jobTitle: e.jobTitle || '', section: e.section || '', hasPin: !!e.pinHash,
        state: !s ? 'off' : ob ? 'break' : 'on', since: s ? (ob ? ob.startAt : s.clockInAt) : null };
    }),
    serverTime: new Date(),
  };
}

function parsePhoto(photo) {
  if (!photo) return null;
  const m = /^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(photo));
  if (!m) throw httpError(400, 'صورة غير صالحة');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 500) throw httpError(400, 'الصورة فارغة — تأكد من الكاميرا');
  if (buf.length > 250 * 1024) throw httpError(413, 'الصورة كبيرة جداً');
  return { mime: m[1], data: buf };
}

/** حضور أو انصراف من جهاز الحضور. action يأتي من حالة الموظف على الشاشة ويُتحقق منها هنا. */
async function punch(body, { req, device, cfg }) {
  const b = body || {};
  const action = b.action === 'out' ? 'out' : b.action === 'in' ? 'in' : '';
  if (!action) throw httpError(400, 'حدد حضوراً أو انصرافاً');
  const ctx = { req, device: device.name };
  const emp = await checkPin(b.employeeId, b.pin, ctx);
  const photo = parsePhoto(b.photo);
  if (!photo && cfg.requirePhoto !== false) throw httpError(400, 'الصورة مطلوبة — اسمح للكاميرا ثم أعد المحاولة');

  const open = await AttendanceShift.findOne({ employee: emp._id, status: 'open' });
  if (action === 'in' && open) throw httpError(409, 'أنت مسجّل حضور مسبقاً — حدّث الشاشة');
  if (action === 'out' && !open) throw httpError(409, 'لا يوجد حضور مفتوح لك — حدّث الشاشة');

  // ضغطتان متتاليتان أو جهازان في نفس اللحظة: واحدة فقط تمر
  const now = new Date();
  const prev = emp.lastPunchAt || null;
  const gate = await Employee.findOneAndUpdate(
    { _id: emp._id, $or: [{ lastPunchAt: null }, { lastPunchAt: { $lt: new Date(now - PUNCH_GAP_MS) } }] },
    { $set: { lastPunchAt: now } }
  );
  if (!gate) throw httpError(429, 'سُجّلت للتو — انتظر دقيقة');
  const undoGate = () => Employee.updateOne({ _id: emp._id, lastPunchAt: now }, { $set: { lastPunchAt: prev } }).catch(() => {});

  const ip = normIp(req.ip);
  let shift;
  try {
    const ph = photo ? await AttendancePhoto.create({ employee: emp._id, kind: action, mime: photo.mime, data: photo.data, expireAt: new Date(Date.now() + (cfg.photoDays || 60) * 864e5) }) : null;
    if (action === 'in') {
      const late = lateOf(emp, now, cfg);
      const flags = []; if (late) flags.push('late'); if (!ph) flags.push('no_photo');
      try {
        shift = await AttendanceShift.create({
          employee: emp._id, employeeName: emp.name, section: emp.section || '', workDay: ammanDay(now), status: 'open',
          clockInAt: now, inDevice: device.name, inIp: ip, inPhoto: ph ? ph._id : null, lateMinutes: late, flags,
        });
      } catch (e) {
        if (e && e.code === 11000) throw httpError(409, 'أنت مسجّل حضور مسبقاً');
        throw e;
      }
    } else {
      const fin = finalize(open, now, emp, cfg);
      if (!ph) fin.flags = [...new Set([...fin.flags, 'no_photo'])];
      shift = await AttendanceShift.findOneAndUpdate(
        { _id: open._id, status: 'open' },
        { $set: { status: 'closed', clockOutAt: now, outDevice: device.name, outIp: ip, outPhoto: ph ? ph._id : null, ...fin } },
        { new: true }
      );
      if (!shift) throw httpError(409, 'سُجّل انصرافك من جهاز آخر');
    }
  } catch (e) { undoGate(); throw e; }

  logActivity({ req, action: `attendance.${action}`, details: { employee: emp.name, device: device.name, workedMinutes: shift.workedMinutes } });
  emit({ employee: String(emp._id), kind: action });
  return {
    action, employee: { id: String(emp._id), name: emp.name }, mustChangePin: pinNeedsChange(emp, cfg),
    shift: { clockInAt: shift.clockInAt, clockOutAt: shift.clockOutAt, workedMinutes: shift.workedMinutes, breakMinutes: shift.breakMinutes, lateMinutes: shift.lateMinutes },
  };
}

/* ═══ البريك (مسؤول القسم) ═══ */
async function loadShiftFor(id, user, cfg, { open = true } = {}) {
  if (!isId(id)) throw httpError(400, 'دوام غير صالح');
  const s = await AttendanceShift.findById(id);
  if (!s) throw httpError(404, 'الدوام غير موجود');
  if (!inScope(scopeFor(user, cfg), s.section)) throw httpError(403, 'هذا الموظف ليس من قسمك');
  if (s.settlement) throw httpError(409, 'هذا الدوام داخل تصفية سابقة — لا يُعدّل');
  if (open && s.status !== 'open') throw httpError(409, 'دوام الموظف مغلق — البريك للمداوم الآن فقط');
  return s;
}

async function startBreak(shiftId, user, body) {
  const cfg = await getConfig();
  const s = await loadShiftFor(shiftId, user, cfg);
  const note = String((body && body.note) || '').trim().slice(0, 120);
  const r = await AttendanceShift.findOneAndUpdate(
    { _id: s._id, status: 'open', breaks: { $not: { $elemMatch: { endAt: null } } } },
    { $push: { breaks: { startAt: new Date(), note, by: user._id, byName: nameOf(user) } } },
    { new: true }
  );
  if (!r) throw httpError(409, 'الموظف في استراحة الآن — أنهِها أولاً');
  logActivity({ user, action: 'attendance.break_start', details: { employee: s.employeeName, note } });
  emit({ employee: String(s.employee), kind: 'break' });
  return publicShift(r.toObject(), cfg);
}

async function endBreak(shiftId, user) {
  const cfg = await getConfig();
  const s = await loadShiftFor(shiftId, user, cfg);
  const ob = (s.breaks || []).find((b) => !b.endAt);
  if (!ob) throw httpError(409, 'الموظف ليس في استراحة');
  const now = new Date();
  const m = mins(ob.startAt, now);
  const upd = { $set: { 'breaks.$[b].endAt': now, 'breaks.$[b].minutes': m, 'breaks.$[b].endedByName': nameOf(user) } };
  if (m > (cfg.longBreakMin || 30)) upd.$addToSet = { flags: 'long_break' };
  const r = await AttendanceShift.findOneAndUpdate({ _id: s._id, status: 'open' }, upd, { new: true, arrayFilters: [{ 'b._id': ob._id, 'b.endAt': null }] });
  if (!r) throw httpError(409, 'تغيّر الدوام — حدّث الشاشة');
  logActivity({ user, action: 'attendance.break_end', details: { employee: s.employeeName, minutes: m } });
  emit({ employee: String(s.employee), kind: 'break_end' });
  return publicShift(r.toObject(), cfg);
}

/** وقت «HH:mm» اليوم بتوقيت عمّان (وإن كان بعد الآن فهو أمس)، أو تاريخ ISO كامل. */
function parseWhen(v, now = new Date()) {
  if (!v) return null;
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (t) {
    let d = new Date(`${ammanDay(now)}T${t[1].padStart(2, '0')}:${t[2]}:00+03:00`);
    if (d > now) d = new Date(d - 864e5);
    return d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** بريك حدث فعلاً: بدايته ومدته بالدقائق. */
async function addPastBreak(shiftId, user, body) {
  const cfg = await getConfig();
  const manage = hasPermission(user, 'attendance:manage');
  const s = await loadShiftFor(shiftId, user, cfg, { open: !manage });
  const b = body || {};
  const start = parseWhen(b.startAt);
  const minutes = Math.round(Number(b.minutes));
  if (!start) throw httpError(400, 'حدد وقت بداية الاستراحة');
  if (!(minutes >= 1 && minutes <= 600)) throw httpError(400, 'مدة الاستراحة بالدقائق (1–600)');
  const end = new Date(start.getTime() + minutes * MIN);
  const limit = s.status === 'closed' ? s.clockOutAt : new Date();
  if (start < s.clockInAt) throw httpError(400, 'الاستراحة قبل وقت حضور الموظف');
  if (end > limit) throw httpError(400, s.status === 'closed' ? 'الاستراحة بعد انصراف الموظف' : 'نهاية الاستراحة في المستقبل — استعمل «بدء استراحة» الآن');
  const now = new Date();
  const clash = (s.breaks || []).some((x) => start < (x.endAt || now) && end > x.startAt);
  if (clash) throw httpError(409, 'تتداخل مع استراحة مسجّلة');
  const note = String(b.note || '').trim().slice(0, 120);
  const n = (s.breaks || []).length;
  const row = { startAt: start, endAt: end, minutes, note, manual: true, by: user._id, byName: nameOf(user), endedByName: nameOf(user) };
  const set = {};
  if (s.status === 'closed') {
    const all = [...s.breaks.map((x) => x.toObject()), row];
    set.breakMinutes = all.reduce((a, x) => a + bmin(x), 0);
    set.workedMinutes = Math.max(0, mins(s.clockInAt, s.clockOutAt) - set.breakMinutes);
  }
  const upd = { $push: { breaks: row }, ...(Object.keys(set).length ? { $set: set } : {}) };
  const add = [];
  if (minutes > (cfg.longBreakMin || 30)) add.push('long_break');
  if (s.status === 'closed') { add.push('manual'); upd.$push.edits = { at: now, byName: nameOf(user), reason: note || 'استراحة بعد الانصراف', change: `استراحة ${minutes} د` }; }
  if (add.length) upd.$addToSet = { flags: { $each: add } };
  if (add.includes('manual')) { upd.$set = { ...(upd.$set || {}), reviewedAt: null }; }
  const r = await AttendanceShift.findOneAndUpdate({ _id: s._id, breaks: { $size: n } }, upd, { new: true });
  if (!r) throw httpError(409, 'تغيّر الدوام — حدّث الشاشة وأعد المحاولة');
  logActivity({ user, action: 'attendance.break_add', details: { employee: s.employeeName, minutes, startAt: start } });
  emit({ employee: String(s.employee), kind: 'break' });
  return publicShift(r.toObject(), cfg);
}

/** حذف بريك سُجّل بالخطأ: المسؤول يحذف ما سجّله هو والدوام مفتوح، والمدير أي بريك. */
async function deleteBreak(shiftId, breakId, user, body) {
  const cfg = await getConfig();
  const manage = hasPermission(user, 'attendance:manage');
  const s = await loadShiftFor(shiftId, user, cfg, { open: !manage });
  const br = (s.breaks || []).find((x) => String(x._id) === String(breakId));
  if (!br) throw httpError(404, 'الاستراحة غير موجودة');
  if (!manage && String(br.by || '') !== String(user._id)) throw httpError(403, 'تحذف ما سجّلته أنت فقط — اطلب من المدير');
  const reason = String((body && body.reason) || '').trim().slice(0, 200);
  const upd = { $pull: { breaks: { _id: br._id } } };
  if (s.status === 'closed') {
    if (!reason) throw httpError(400, 'اكتب سبب التعديل');
    const rest = s.breaks.filter((x) => String(x._id) !== String(br._id));
    const bm = rest.reduce((a, x) => a + bmin(x), 0);
    upd.$set = { breakMinutes: bm, workedMinutes: Math.max(0, mins(s.clockInAt, s.clockOutAt) - bm), reviewedAt: null };
    upd.$push = { edits: { at: new Date(), byName: nameOf(user), reason, change: `حذف استراحة ${br.minutes || 0} د` } };
    upd.$addToSet = { flags: 'manual' };
  }
  const r = await AttendanceShift.findOneAndUpdate({ _id: s._id, 'breaks._id': br._id }, upd, { new: true });
  if (!r) throw httpError(409, 'تغيّر الدوام — حدّث الشاشة');
  logActivity({ user, action: 'attendance.break_delete', details: { employee: s.employeeName, minutes: br.minutes, reason } });
  emit({ employee: String(s.employee), kind: 'break' });
  return publicShift(r.toObject(), cfg);
}

/* ═══ الآن (لمسؤول القسم والمدير) ═══ */
async function live(user) {
  const cfg = await getConfig();
  const scope = scopeFor(user, cfg);
  const [open, emps] = await Promise.all([
    AttendanceShift.find({ status: 'open', ...(scope ? { section: { $in: scope } } : {}) }).sort({ clockInAt: 1 }).lean(),
    Employee.find({ active: true, ...(scope ? { section: { $in: scope } } : {}) }).select('name jobTitle section pinLockedUntil').sort({ section: 1, name: 1 }).lean(),
  ]);
  const onIds = new Set(open.map((s) => String(s.employee)));
  return {
    scope, sections: [...new Set(emps.map((e) => e.section || ''))],
    shifts: open.map((s) => publicShift(s, cfg)),
    off: emps.filter((e) => !onIds.has(String(e._id))).map((e) => ({ id: String(e._id), name: e.name, jobTitle: e.jobTitle || '', section: e.section || '', locked: !!(e.pinLockedUntil && e.pinLockedUntil > new Date()) })),
    longBreakMin: cfg.longBreakMin, maxShiftHours: cfg.maxShiftHours,
  };
}

/* ═══ إدارة (المدير) ═══ */
function needReason(b) { const r = String((b && b.reason) || '').trim().slice(0, 200); if (!r) throw httpError(400, 'اكتب سبب التعديل'); return r; }

/**
 * إغلاق دوام مفتوح (نسي الموظف الانصراف) — mode:
 *   time  انصراف يدوي بالوقت المحدد (الافتراضي)
 *   half  نصف دوام: ساعات العمل = نصف ساعات الموظف، والانصراف = الحضور + المدة
 *   off   عطلة: اليوم بلا ساعات (يُعدّ في العطل لا في أيام الدوام)
 */
async function closeShift(id, user, body) {
  const cfg = await getConfig();
  if (!isId(id)) throw httpError(400, 'دوام غير صالح');
  const reason = needReason(body);
  const mode = ['half', 'off'].includes(body.mode) ? body.mode : 'time';
  const s = await AttendanceShift.findById(id);
  if (!s || s.status !== 'open') throw httpError(409, 'الدوام ليس مفتوحاً');
  const emp = await Employee.findById(s.employee).lean();
  let set; let change;
  if (mode === 'time') {
    const at = parseWhen(body.at) || new Date();
    if (at < s.clockInAt || at > new Date()) throw httpError(400, 'وقت الانصراف بين الحضور والآن');
    const fin = finalize(s, at, emp, cfg);
    fin.flags = [...new Set([...fin.flags, 'closed_by_manager', 'manual'])];
    set = { status: 'closed', clockOutAt: at, ...fin };
    change = `انصراف يدوي ${at.toISOString()}`;
  } else {
    const worked = mode === 'half' ? halfMinutes(emp) : 0;
    const out = new Date(Math.min(Date.now(), s.clockInAt.getTime() + worked * MIN));
    const breaks = (s.breaks || []).map((b) => { const o = b.toObject(); if (!o.endAt) { o.endAt = out < o.startAt ? o.startAt : out; o.minutes = mins(o.startAt, o.endAt); o.endedByName = nameOf(user); } return o; });
    const flags = new Set((s.flags || []).filter((f) => f !== 'late' || mode === 'half'));
    ['closed_by_manager', 'manual', mode === 'half' ? 'half_day' : 'day_off'].forEach((f) => flags.add(f));
    set = { status: 'closed', clockOutAt: out, dayType: mode, workedMinutes: worked, breakMinutes: 0, breaks, flags: [...flags], ...(mode === 'off' ? { lateMinutes: 0 } : {}) };
    change = mode === 'half' ? `نصف دوام (${worked} د)` : 'عطلة';
  }
  const r = await AttendanceShift.findOneAndUpdate({ _id: s._id, status: 'open' },
    { $set: { ...set, closedByName: nameOf(user), outDevice: 'المدير', reviewedAt: null }, $push: { edits: { at: new Date(), byName: nameOf(user), reason, change } } }, { new: true });
  if (!r) throw httpError(409, 'تغيّر الدوام — حدّث الشاشة');
  logActivity({ user, action: 'attendance.close', details: { employee: s.employeeName, reason } });
  emit({ employee: String(s.employee), kind: 'out' });
  return publicShift(r.toObject(), cfg);
}

async function editShift(id, user, body) {
  const cfg = await getConfig();
  if (!isId(id)) throw httpError(400, 'دوام غير صالح');
  const reason = needReason(body);
  const s = await AttendanceShift.findById(id);
  if (!s) throw httpError(404, 'الدوام غير موجود');
  if (s.settlement) throw httpError(409, 'هذا الدوام داخل تصفية سابقة — لا يُعدّل');
  const inAt = body.clockInAt ? parseWhen(body.clockInAt) : s.clockInAt;
  const outAt = s.status === 'closed' ? (body.clockOutAt ? parseWhen(body.clockOutAt) : s.clockOutAt) : null;
  if (!inAt || (s.status === 'closed' && !outAt)) throw httpError(400, 'وقت غير صحيح');
  if (inAt > new Date() || (outAt && (outAt <= inAt || outAt > new Date()))) throw httpError(400, 'الانصراف بعد الحضور ولا يكون في المستقبل');
  const lo = inAt; const hi = outAt || new Date();
  if ((s.breaks || []).some((b) => b.startAt < lo || (b.endAt || new Date()) > hi)) throw httpError(400, 'توجد استراحة خارج الأوقات الجديدة — احذفها أولاً');
  const emp = await Employee.findById(s.employee).lean();
  const set = { clockInAt: inAt, workDay: ammanDay(inAt), lateMinutes: lateOf(emp || {}, inAt, cfg), reviewedAt: null };
  if (outAt) {
    set.clockOutAt = outAt;
    const bm = (s.breaks || []).reduce((a, b) => a + bmin(b), 0);
    set.breakMinutes = bm; set.workedMinutes = Math.max(0, mins(inAt, outAt) - bm);
  }
  const flags = new Set(s.flags || []); flags.add('manual');
  if (set.lateMinutes) flags.add('late'); else flags.delete('late');
  set.flags = [...flags];
  const change = `حضور ${s.clockInAt.toISOString()}→${inAt.toISOString()}${outAt ? ` · انصراف ${s.clockOutAt.toISOString()}→${outAt.toISOString()}` : ''}`;
  const r = await AttendanceShift.findOneAndUpdate({ _id: s._id, updatedAt: s.updatedAt }, { $set: set, $push: { edits: { at: new Date(), byName: nameOf(user), reason, change } } }, { new: true });
  if (!r) throw httpError(409, 'تغيّر الدوام — حدّث الشاشة');
  logActivity({ user, action: 'attendance.edit', details: { employee: s.employeeName, reason, change } });
  emit({ employee: String(s.employee), kind: 'edit' });
  return publicShift(r.toObject(), cfg);
}

async function createManual(user, body) {
  const cfg = await getConfig();
  const b = body || {};
  const reason = needReason(b);
  if (!isId(b.employeeId)) throw httpError(400, 'اختر الموظف');
  const emp = await Employee.findById(b.employeeId).lean();
  if (!emp) throw httpError(404, 'الموظف غير موجود');
  const inAt = parseWhen(b.clockInAt); const outAt = b.clockOutAt ? parseWhen(b.clockOutAt) : null;
  if (!inAt || inAt > new Date()) throw httpError(400, 'وقت الحضور غير صحيح');
  if (outAt && (outAt <= inAt || outAt > new Date())) throw httpError(400, 'الانصراف بعد الحضور ولا يكون في المستقبل');
  const late = lateOf(emp, inAt, cfg);
  const doc = {
    employee: emp._id, employeeName: emp.name, section: emp.section || '', workDay: ammanDay(inAt), clockInAt: inAt, inDevice: 'المدير',
    lateMinutes: late, flags: ['manual', ...(late ? ['late'] : [])], edits: [{ at: new Date(), byName: nameOf(user), reason, change: 'دوام يدوي' }],
  };
  if (outAt) Object.assign(doc, { status: 'closed', clockOutAt: outAt, outDevice: 'المدير', closedByName: nameOf(user), workedMinutes: mins(inAt, outAt), breakMinutes: 0 });
  let s;
  try { s = await AttendanceShift.create(doc); } catch (e) { if (e && e.code === 11000) throw httpError(409, 'للموظف حضور مفتوح الآن'); throw e; }
  logActivity({ user, action: 'attendance.manual', details: { employee: emp.name, reason } });
  emit({ employee: String(emp._id), kind: 'edit' });
  return publicShift(s.toObject(), cfg);
}

async function reviewShift(id, user, body) {
  const cfg = await getConfig();
  if (!isId(id)) throw httpError(400, 'دوام غير صالح');
  const note = String((body && body.note) || '').trim().slice(0, 200);
  const r = await AttendanceShift.findByIdAndUpdate(id, { $set: { reviewedAt: new Date(), reviewedByName: nameOf(user), reviewNote: note } }, { new: true });
  if (!r) throw httpError(404, 'الدوام غير موجود');
  logActivity({ user, action: 'attendance.review', details: { employee: r.employeeName, note } });
  return publicShift(r.toObject(), cfg, { photos: true });
}

async function exceptions() {
  const cfg = await getConfig();
  const since = new Date(Date.now() - 62 * 864e5);
  const longOpen = new Date(Date.now() - (cfg.maxShiftHours || 14) * 3600e3);
  const rows = await AttendanceShift.find({
    reviewedAt: null, clockInAt: { $gte: since },
    $or: [{ 'flags.0': { $exists: true } }, { status: 'open', clockInAt: { $lt: longOpen } }],
  }).sort({ clockInAt: -1 }).limit(200).lean();
  const ActivityLog = require('../models/ActivityLog');
  const locks = await ActivityLog.find({ action: 'attendance.pin_locked', createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } }).sort({ createdAt: -1 }).limit(50).lean();
  return {
    shifts: rows.map((s) => publicShift(s, cfg, { photos: true })).filter((s) => s.flags.length),
    lockouts: locks.map((l) => ({ at: l.createdAt, employee: (l.details || {}).employee || '', device: (l.details || {}).device || '', ip: l.ip || '' })),
    labels: FLAG_LABELS,
  };
}

/* ═══ التقارير وسجل الموظف ═══ */
function rangeOf(q) {
  const def = monthRange();
  const from = validDay(q && q.from) ? q.from : def.from;
  const to = validDay(q && q.to) ? q.to : def.to;
  return from <= to ? { from, to } : { from: to, to: from };
}
function summarizeRows(shifts, now = new Date()) {
  const days = new Set(); const halfDays = new Set(); const offDays = new Set();
  let worked = 0; let brk = 0; let brkCount = 0; let late = 0; let lateMin = 0; let open = 0;
  shifts.forEach((s) => {
    if (s.dayType === 'off') { offDays.add(s.workDay); return; }
    if (s.dayType === 'half') halfDays.add(s.workDay);
    days.add(s.workDay);
    worked += liveWorked(s, now);
    const bt = breakTotals(s.breaks, now);
    brk += s.status === 'closed' ? s.breakMinutes || 0 : bt.minutes; brkCount += bt.count;
    if (s.lateMinutes) { late += 1; lateMin += s.lateMinutes; }
    if (s.status === 'open') open += 1;
  });
  return { days: days.size, halfDays: halfDays.size, offDays: offDays.size, shifts: shifts.length, workedMinutes: worked, breakMinutes: brk, breakCount: brkCount, lateCount: late, lateMinutes: lateMin, open };
}

async function report(query, user) {
  const cfg = await getConfig();
  const { from, to } = rangeOf(query);
  const scope = scopeFor(user, cfg);
  const shifts = await AttendanceShift.find({ workDay: { $gte: from, $lte: to }, ...(scope ? { section: { $in: scope } } : {}) }).lean();
  const emps = await Employee.find(scope ? { section: { $in: scope } } : {}).select('name jobTitle section active').lean();
  const by = new Map();
  shifts.forEach((s) => { const k = String(s.employee); if (!by.has(k)) by.set(k, []); by.get(k).push(s); });
  const rows = emps.filter((e) => e.active || by.has(String(e._id))).map((e) => ({
    id: String(e._id), name: e.name, jobTitle: e.jobTitle || '', section: e.section || '', ...summarizeRows(by.get(String(e._id)) || []),
  })).sort((a, b) => b.workedMinutes - a.workedMinutes || a.name.localeCompare(b.name, 'ar'));
  return { from, to, rows, totals: summarizeRows(shifts) };
}

async function employeeRecord(id, query, user) {
  if (!isId(id)) throw httpError(400, 'موظف غير صالح');
  const cfg = await getConfig();
  const emp = await Employee.findById(id).select('+pinHash').lean();
  if (!emp) throw httpError(404, 'الموظف غير موجود');
  // مسؤول القسم (بلا صلاحيات الموظفين أو التقارير): موظفو أقسامه فقط
  const wide = !user || user.role === 'manager' || ['attendance:view', 'employees:manage', 'employees:pay', 'employees:view'].some((k) => hasPermission(user, k));
  if (!wide && !inScope(scopeFor(user, cfg), emp.section)) throw httpError(403, 'هذا الموظف ليس من قسمك');
  const { from, to } = rangeOf(query);
  const shifts = await AttendanceShift.find({ employee: emp._id, workDay: { $gte: from, $lte: to } }).sort({ clockInAt: -1 }).lean();
  return {
    from, to,
    employee: { id: String(emp._id), name: emp.name, section: emp.section || '', shiftStart: emp.shiftStart || '', shiftHours: emp.shiftHours || 0,
      hasPin: !!emp.pinHash, pinSetAt: emp.pinSetAt, pinMustChange: !!emp.pinMustChange, locked: !!(emp.pinLockedUntil && emp.pinLockedUntil > new Date()) },
    summary: summarizeRows(shifts),
    shifts: shifts.map((s) => publicShift(s, cfg)),
    labels: FLAG_LABELS,
  };
}

async function photo(id) {
  if (!isId(id)) throw httpError(400, 'صورة غير صالحة');
  const p = await AttendancePhoto.findById(id).lean();
  if (!p) throw httpError(404, 'الصورة غير موجودة أو انتهت مدة حفظها');
  // lean قد يعيد Binary من MongoDB أو كائناً — نحوّله إلى Buffer
  const d = p.data;
  const data = Buffer.isBuffer(d) ? d : d && d.buffer ? Buffer.from(d.buffer) : d && Array.isArray(d.data) ? Buffer.from(d.data) : Buffer.from(d || []);
  return { mime: p.mime || 'image/jpeg', data };
}

/** من يمكن إضافته «مسؤول قسم» يسجّل الاستراحات: أي مستخدم للمطعم (الإضافة نفسها تمنحه التسجيل). */
async function supervisorCandidates() {
  const User = require('../models/User');
  const users = await User.find({ isActive: { $ne: false }, role: { $nin: ['delivery', 'center', 'company', 'admin'] } }).select('name username role').sort({ name: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: nameOf(u), role: u.role }));
}


/* ═══ العطل ونصف الدوام لتاريخ محدد (المدير) ═══ */
/** يسجّل يوم «عطلة» أو «نصف دوام» لموظف في تاريخ لا دوام فيه. */
async function markDay(user, body) {
  const b = body || {};
  const reason = needReason(b);
  const kind = b.kind === 'half' ? 'half' : 'off';
  if (!isId(b.employeeId)) throw httpError(400, 'اختر الموظف');
  const day = validDay(b.day) ? b.day : ammanDay();
  if (day > ammanDay()) throw httpError(400, 'لا يُسجَّل يوم في المستقبل');
  const emp = await Employee.findById(b.employeeId).lean();
  if (!emp) throw httpError(404, 'الموظف غير موجود');
  if (await AttendanceShift.exists({ employee: emp._id, workDay: day })) throw httpError(409, 'للموظف دوام مسجّل في هذا اليوم — عدّله من سجله بدل إضافة يوم جديد');
  const st = toMin(emp.shiftStart);
  const inAt = new Date(dayStart(day).getTime() + (st === null ? 12 * 60 : st) * MIN);
  const worked = kind === 'half' ? halfMinutes(emp) : 0;
  const s = await AttendanceShift.create({
    employee: emp._id, employeeName: emp.name, section: emp.section || '', workDay: day, status: 'closed', dayType: kind,
    clockInAt: inAt, clockOutAt: new Date(inAt.getTime() + worked * MIN), inDevice: 'المدير', outDevice: 'المدير', closedByName: nameOf(user),
    workedMinutes: worked, flags: ['manual', kind === 'half' ? 'half_day' : 'day_off'], reviewedAt: new Date(), reviewedByName: nameOf(user),
    edits: [{ at: new Date(), byName: nameOf(user), reason, change: DAY_LABELS[kind] }],
  });
  logActivity({ user, action: `attendance.${kind === 'half' ? 'half' : 'off'}`, details: { employee: emp.name, day, reason } });
  emit({ employee: String(emp._id), kind: 'edit' });
  return publicShift(s.toObject(), await getConfig());
}

/** حذف يوم عطلة/نصف دوام سُجّل بالخطأ (قبل التصفية). */
async function deleteDay(id, user) {
  if (!isId(id)) throw httpError(400, 'يوم غير صالح');
  const s = await AttendanceShift.findById(id).lean();
  if (!s) throw httpError(404, 'غير موجود');
  if (s.settlement) throw httpError(409, 'داخل تصفية سابقة — لا يُحذف');
  if (!(s.dayType === 'off' || s.dayType === 'half') || s.inDevice !== 'المدير') throw httpError(400, 'يُحذف فقط يوم عطلة أو نصف دوام سجّله المدير');
  await AttendanceShift.deleteOne({ _id: s._id, settlement: null });
  logActivity({ user, action: 'attendance.day_delete', details: { employee: s.employeeName, day: s.workDay, dayType: s.dayType } });
  emit({ employee: String(s.employee), kind: 'edit' });
}

/* ═══ التنبيهات: دوام مفتوح أكثر من الحد · استراحة مفتوحة طويلة ═══ */
const tFmt = new Intl.DateTimeFormat('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman', hour: 'numeric', minute: '2-digit' });
function notify(type, payload, details) {
  emit({ kind: 'alert', alert: type, ...payload });
  try { realtime = realtime || require('./realtimeService'); realtime.broadcast('attendance.alert', { alert: type, ...payload }); } catch (_) { /* */ }
  try { require('./staffAlertService').emit(type, { userName: 'الدوام', details }); } catch (_) { /* */ }
}
/** فحص واحد (كل دقيقة من start) — كل تنبيه يُرسل مرة واحدة لكل دوام/استراحة. */
async function checkAlerts(now = new Date()) {
  const cfg = await getConfig();
  const sent = [];
  const longBefore = new Date(now - (cfg.maxShiftHours || 11) * 3600e3);
  const longOpen = await AttendanceShift.find({ status: 'open', clockInAt: { $lt: longBefore }, alertLongAt: null }).lean();
  for (const sh of longOpen) {
    const r = await AttendanceShift.updateOne({ _id: sh._id, status: 'open', alertLongAt: null }, { $set: { alertLongAt: now } });
    if (!r.modifiedCount) continue;
    const hours = Math.floor((now - sh.clockInAt) / 3600e3);
    notify('attendance.long', { shiftId: String(sh._id), employee: String(sh.employee), employeeName: sh.employeeName, hours },
      { employee: sh.employeeName, hours, since: tFmt.format(sh.clockInAt), section: sh.section });
    sent.push({ type: 'long', employee: sh.employeeName });
  }
  const brkBefore = new Date(now - (cfg.longBreakMin || 30) * MIN);
  const onBreak = await AttendanceShift.find({ status: 'open', breaks: { $elemMatch: { endAt: null, startAt: { $lt: brkBefore }, alertedAt: null } } }).lean();
  for (const sh of onBreak) {
    const b = (sh.breaks || []).find((x) => !x.endAt && x.startAt < brkBefore && !x.alertedAt);
    if (!b) continue;
    const r = await AttendanceShift.updateOne({ _id: sh._id, status: 'open' }, { $set: { 'breaks.$[b].alertedAt': now } }, { arrayFilters: [{ 'b._id': b._id, 'b.alertedAt': null, 'b.endAt': null }] });
    if (!r.modifiedCount) continue;
    const minutes = mins(b.startAt, now);
    notify('attendance.break', { shiftId: String(sh._id), employee: String(sh.employee), employeeName: sh.employeeName, minutes },
      { employee: sh.employeeName, minutes, since: tFmt.format(b.startAt), by: b.byName });
    sent.push({ type: 'break', employee: sh.employeeName });
  }
  return sent;
}
let watchTimer = null;
function start() {
  if (watchTimer) return;
  const tick = () => checkAlerts().catch((e) => console.error('attendance alerts:', e.message));
  watchTimer = setInterval(tick, 60 * 1000);
  if (watchTimer.unref) watchTimer.unref();
  setTimeout(tick, 15000).unref?.();
}

/* ═══ الفترة الجارية (منذ آخر تصفية) والتصفية والأرشيف ═══ */
const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const KINDS = { salary: 'راتب', advance: 'سلفة', bonus: 'مكافأة', other: 'أخرى', general: 'صرف' };
function paidTotals(rows) {
  const t = { salary: 0, advance: 0, bonus: 0, other: 0, all: 0, count: rows.length };
  rows.forEach((e) => { const k = ['salary', 'advance', 'bonus'].includes(e.kind) ? e.kind : 'other'; t[k] += e.amount || 0; t.all += e.amount || 0; });
  Object.keys(t).forEach((k) => { if (k !== 'count') t[k] = r3(t[k]); });
  return t;
}
const shiftRow = (x) => ({
  id: String(x._id), workDay: x.workDay, dayType: x.dayType || 'work', status: x.status, clockInAt: x.clockInAt, clockOutAt: x.clockOutAt,
  workedMinutes: liveWorked(x), breakMinutes: x.status === 'closed' ? x.breakMinutes || 0 : breakTotals(x.breaks).minutes,
  breaks: (x.breaks || []).map((b) => ({ startAt: b.startAt, endAt: b.endAt, minutes: bmin(b), note: b.note || '', byName: b.byName || '' })),
  lateMinutes: x.lateMinutes || 0, flags: x.flags || [],
});
const payRow = (e) => ({ id: String(e._id), number: e.number, kind: e.kind, kindLabel: KINDS[e.kind] || 'صرف', name: e.name || '', amount: r3(e.amount), at: e.spentAt || e.createdAt, source: e.source || '', byName: e.createdByName || e.approvedByName || '' });

async function currentPeriod(emp) {
  const Expense = require('../models/Expense');
  const [shifts, pays] = await Promise.all([
    AttendanceShift.find({ employee: emp._id, settlement: null }).sort({ clockInAt: -1 }).lean(),
    Expense.find({ employee: emp._id, voided: { $ne: true }, settlement: null }).select('-approvedSignature').sort({ spentAt: -1, createdAt: -1 }).lean(),
  ]);
  const paid = paidTotals(pays);
  return {
    since: emp.lastSettledAt || null, summary: summarizeRows(shifts), shifts, payments: pays, paid,
    salary: r3(emp.salary), remaining: r3((emp.salary || 0) - paid.salary - paid.advance),
  };
}

async function loadEmployeeFor(id, user) {
  if (!isId(id)) throw httpError(400, 'موظف غير صالح');
  const cfg = await getConfig();
  const acc = accessOf(user, cfg);
  if (!acc.view) throw httpError(403, 'ليس لديك صلاحية');
  const emp = await Employee.findById(id).select('+pinHash').lean();
  if (!emp) throw httpError(404, 'الموظف غير موجود');
  if (!acc.payments && !acc.manage && !inScope(acc.scope, emp.section)) throw httpError(403, 'هذا الموظف ليس من قسمك');
  return { emp, cfg, acc };
}

/** ملف الموظف الكامل: الدوامات والاستراحات والعطل والراتب والمصاريف منذ آخر تصفية + أرشيف التصفيات. */
async function employeeFull(id, user) {
  const { emp, cfg, acc } = await loadEmployeeFor(id, user);
  const cur = await currentPeriod(emp);
  const EmployeeSettlement = require('../models/EmployeeSettlement');
  const settlements = await EmployeeSettlement.find({ employee: emp._id }).select('number from to summary paid salary remaining byName createdAt note').sort({ createdAt: -1 }).limit(60).lean();
  return {
    access: { payments: acc.payments, settle: acc.settle, manage: acc.manage },
    employee: {
      id: String(emp._id), name: emp.name, jobTitle: emp.jobTitle || '', phone: emp.phone || '', section: emp.section || '', active: emp.active !== false,
      startDate: emp.startDate, shiftStart: emp.shiftStart || '', shiftHours: emp.shiftHours || 0, salary: acc.payments ? r3(emp.salary) : null,
      hasPin: !!emp.pinHash, locked: !!(emp.pinLockedUntil && emp.pinLockedUntil > new Date()), lastSettledAt: emp.lastSettledAt || null,
    },
    period: {
      since: cur.since, summary: cur.summary,
      shifts: cur.shifts.map((x) => publicShift(x, cfg)),
      ...(acc.payments ? { payments: cur.payments.map(payRow), paid: cur.paid, salary: cur.salary, remaining: cur.remaining } : {}),
    },
    settlements: settlements.map((x) => ({ id: String(x._id), number: x.number, from: x.from, to: x.to, summary: x.summary, createdAt: x.createdAt, byName: x.byName, note: x.note,
      ...(acc.payments ? { paid: x.paid, salary: x.salary, remaining: x.remaining } : {}) })),
    labels: FLAG_LABELS, dayLabels: DAY_LABELS,
  };
}

/** قائمة الموظفين بأرقام الفترة الجارية (لصفحة «الموظفون»). */
async function employeesOverview(user, { all = false } = {}) {
  const cfg = await getConfig();
  const acc = accessOf(user, cfg);
  if (!acc.view) throw httpError(403, 'ليس لديك صلاحية');
  const scope = acc.payments || acc.manage ? null : acc.scope;
  const emps = await Employee.find({ ...(all ? {} : { active: true }), ...(scope ? { section: { $in: scope } } : {}) }).sort({ section: 1, name: 1 }).lean();
  const ids = emps.map((e) => e._id);
  const Expense = require('../models/Expense');
  const [shifts, pays] = await Promise.all([
    AttendanceShift.find({ employee: { $in: ids }, settlement: null }).lean(),
    acc.payments ? Expense.find({ employee: { $in: ids }, voided: { $ne: true }, settlement: null }).select('employee amount kind').lean() : [],
  ]);
  const group = (rows) => { const m = new Map(); rows.forEach((r) => { const k = String(r.employee); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
  const sh = group(shifts); const py = group(pays);
  return {
    access: { payments: acc.payments, settle: acc.settle, manage: acc.manage },
    rows: emps.map((e) => {
      const list = sh.get(String(e._id)) || [];
      const paid = acc.payments ? paidTotals(py.get(String(e._id)) || []) : null;
      return {
        id: String(e._id), name: e.name, jobTitle: e.jobTitle || '', section: e.section || '', active: e.active !== false, lastSettledAt: e.lastSettledAt || null,
        onDuty: list.some((x) => x.status === 'open'), summary: summarizeRows(list),
        ...(paid ? { salary: r3(e.salary), paid, remaining: r3((e.salary || 0) - paid.salary - paid.advance) } : {}),
      };
    }),
  };
}

/**
 * تصفية الموظف: كل دوام مغلق وكل سند صرف غير مُصفّى حتى الآن يدخل التصفية،
 * فتعود الفترة الجارية إلى الصفر، وتُحفظ صورة كاملة في الأرشيف. الدوام المفتوح الآن يبقى للفترة القادمة.
 */
async function settle(id, user, body) {
  const { emp, acc } = await loadEmployeeFor(id, user);
  if (!acc.settle) throw httpError(403, 'التصفية لمدير النظام أو لمن يملك إدارة الدوام وإدارة/صرف الموظفين');
  const note = String((body && body.note) || '').trim().slice(0, 300);
  const now = new Date();
  // قفل قصير: لا تصفيتان للموظف نفسه في اللحظة نفسها
  const lock = await Employee.findOneAndUpdate({ _id: emp._id, $or: [{ settlingAt: null }, { settlingAt: { $lt: new Date(now - 2 * MIN) } }] }, { $set: { settlingAt: now } });
  if (!lock) throw httpError(409, 'تصفية هذا الموظف قيد التنفيذ من جهاز آخر');
  const EmployeeSettlement = require('../models/EmployeeSettlement');
  const Expense = require('../models/Expense');
  const Counter = require('../models/Counter');
  const sid = new mongoose.Types.ObjectId();
  try {
    const [shRes, exRes] = await Promise.all([
      AttendanceShift.updateMany({ employee: emp._id, status: 'closed', settlement: null }, { $set: { settlement: sid } }),
      Expense.updateMany({ employee: emp._id, voided: { $ne: true }, settlement: null }, { $set: { settlement: sid } }),
    ]);
    if (!shRes.modifiedCount && !exRes.modifiedCount) throw httpError(400, 'لا شيء للتصفية — لا دوامات مغلقة ولا صرف منذ آخر تصفية');
    const [shifts, pays] = await Promise.all([
      AttendanceShift.find({ settlement: sid }).sort({ clockInAt: 1 }).lean(),
      Expense.find({ settlement: sid }).select('-approvedSignature').sort({ spentAt: 1, createdAt: 1 }).lean(),
    ]);
    const paid = paidTotals(pays);
    const firstAt = [...shifts.map((x) => x.clockInAt), ...pays.map((p) => p.spentAt || p.createdAt)].filter(Boolean).sort((a, b) => a - b)[0] || emp.lastSettledAt || now;
    const c = await Counter.findOneAndUpdate({ _id: 'employeeSettlement' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    const doc = await EmployeeSettlement.create({
      _id: sid, number: c.seq, employee: emp._id, employeeName: emp.name, jobTitle: emp.jobTitle || '', section: emp.section || '',
      from: emp.lastSettledAt && emp.lastSettledAt < firstAt ? emp.lastSettledAt : firstAt, to: now, salary: r3(emp.salary),
      summary: summarizeRows(shifts), shifts: shifts.map(shiftRow), payments: pays.map(payRow), paid,
      remaining: r3((emp.salary || 0) - paid.salary - paid.advance), note, byName: nameOf(user), by: user._id,
    });
    await Employee.updateOne({ _id: emp._id }, { $set: { lastSettledAt: now, settlingAt: null } });
    logActivity({ user, action: 'attendance.settle', amount: paid.all, details: { employee: emp.name, number: doc.number, shifts: shifts.length, payments: pays.length } });
    emit({ employee: String(emp._id), kind: 'settle' });
    return doc.toObject();
  } catch (e) {
    // لا تصفية ناقصة: نعيد ما عُلّم
    await Promise.all([
      AttendanceShift.updateMany({ settlement: sid }, { $set: { settlement: null } }),
      Expense.updateMany({ settlement: sid }, { $set: { settlement: null } }),
      Employee.updateOne({ _id: emp._id }, { $set: { settlingAt: null } }),
    ]).catch(() => {});
    throw e;
  }
}

async function getSettlement(id, user) {
  if (!isId(id)) throw httpError(400, 'تصفية غير صالحة');
  const EmployeeSettlement = require('../models/EmployeeSettlement');
  const x = await EmployeeSettlement.findById(id).lean();
  if (!x) throw httpError(404, 'التصفية غير موجودة');
  const { acc } = await loadEmployeeFor(x.employee, user);
  if (!acc.payments) { delete x.payments; delete x.paid; delete x.salary; delete x.remaining; }
  return { ...x, id: String(x._id), dayLabels: DAY_LABELS };
}

/* ═══ الطباعة: الخادم يبني الورقة الحرارية ← مهمة html ← محطة الطباعة (الطابعة الرئيسية) ═══ */
const receipts = require('../alburaq/receipts');
const PrintJob = require('../models/PrintJob');
const PRINT_TTL_MS = 10 * 60 * 1000;
const hm = (m) => `${Math.floor((m || 0) / 60)}:${String(Math.round(m || 0) % 60).padStart(2, '0')}`;
const m3 = (n) => Number(n || 0).toFixed(3);
const dShort = new Intl.DateTimeFormat('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman', day: 'numeric', month: 'numeric' });
const dFull = new Intl.DateTimeFormat('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman', year: 'numeric', month: 'numeric', day: 'numeric' });
const hEsc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function brandName() {
  try { const st = await require('../models/Setting').findOne().select('restaurantName').lean(); return (st && st.restaurantName) || 'البراق'; } catch (_) { return 'البراق'; }
}
function sheetHtml({ brand, title, emp, from, to, summary, shifts, payments, paid, salary, remaining, number, byName, note }) {
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  const shiftLines = (shifts || []).slice().sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt)).map((x) => {
    const dt = x.dayType || 'work';
    const what = dt === 'off' ? 'عطلة' : dt === 'half' ? `نصف · ${hm(x.workedMinutes)}` : `${tFmt.format(new Date(x.clockInAt))}–${x.status === 'open' ? '…' : tFmt.format(new Date(x.clockOutAt))}`;
    return `<tr><td>${dShort.format(new Date(`${x.workDay}T12:00:00+03:00`))}</td><td>${hEsc(what)}</td><td class="num">${dt === 'off' ? '—' : hm(x.workedMinutes)}</td><td class="num">${x.breakMinutes || 0}</td></tr>`;
  }).join('');
  const payLines = (payments || []).map((p) => `<tr><td>${dShort.format(new Date(p.at))}</td><td>#${p.number} ${hEsc(p.kindLabel || KINDS[p.kind] || '')}</td><td class="num">${m3(p.amount)}</td></tr>`).join('');
  const body = `
    <h1>${hEsc(brand)}</h1>
    <div class="sub">${hEsc(title)}${number ? ` #${number}` : ''}</div>
    ${row('الموظف', `<b>${hEsc(emp.name)}</b>`)}
    ${emp.jobTitle || emp.section ? row('الوظيفة', hEsc([emp.jobTitle, emp.section].filter(Boolean).join(' · '))) : ''}
    ${row('الفترة', `${from ? dFull.format(new Date(from)) : 'البداية'} ← ${dFull.format(new Date(to || Date.now()))}`)}
    <hr>
    ${row('أيام الدوام', `<b>${summary.days || 0}</b>`)}
    ${summary.halfDays ? row('منها نصف دوام', summary.halfDays) : ''}
    ${row('العطل', summary.offDays || 0)}
    ${row('ساعات العمل', `<b>${hm(summary.workedMinutes)}</b>`)}
    ${row('الاستراحات', `${summary.breakCount || 0} · ${summary.breakMinutes || 0} د`)}
    ${row('التأخير', `${summary.lateCount || 0}${summary.lateMinutes ? ` · ${summary.lateMinutes} د` : ''}`)}
    ${shiftLines ? `<hr><table><thead><tr><th>اليوم</th><th>الدوام</th><th class="num">عمل</th><th class="num">استراحة</th></tr></thead><tbody>${shiftLines}</tbody></table>` : ''}
    ${paid ? `<hr>
    ${row('الراتب الشهري', m3(salary))}
    ${row('رواتب مصروفة', m3(paid.salary))}
    ${row('سلف', m3(paid.advance))}
    ${paid.bonus ? row('مكافآت', m3(paid.bonus)) : ''}
    ${paid.other ? row('أخرى', m3(paid.other)) : ''}
    ${payLines ? `<table><tbody>${payLines}</tbody></table>` : ''}
    <div class="row total"><span>المتبقي من الراتب</span><span>${m3(remaining)}</span></div>` : ''}
    ${note ? `<div class="foot">${hEsc(note)}</div>` : ''}
    <div class="foot">${number ? `صُفّي بواسطة ${hEsc(byName || '')} — ` : ''}طُبع ${hEsc(dFull.format(new Date()))} ${hEsc(tFmt.format(new Date()))}<br><br>توقيع الموظف ............ &nbsp; المدير ............</div>`;
  return receipts.page(title, receipts.logoDataUri(), body);
}
async function queueHtml(title, html, user) {
  const job = await PrintJob.create({ type: 'html', payload: { title: String(title).slice(0, 80), html }, requestedBy: user._id, requestedByName: nameOf(user), expiresAt: new Date(Date.now() + PRINT_TTL_MS) });
  try { realtime = realtime || require('./realtimeService'); realtime.emitPrintJob(job); } catch (_) { /* */ }
  logActivity({ user, action: 'attendance.print', details: { title } });
  return { jobId: String(job._id) };
}

/** كشف الفترة الجارية للموظف — أو تصفية سابقة (settlementId). */
async function printEmployee(id, user) {
  const { emp, acc } = await loadEmployeeFor(id, user);
  const cur = await currentPeriod(emp);
  const html = sheetHtml({ brand: await brandName(), title: 'كشف دوام وحساب موظف', emp, from: cur.since || (cur.shifts.length ? cur.shifts[cur.shifts.length - 1].clockInAt : null), to: new Date(),
    summary: cur.summary, shifts: cur.shifts.map(shiftRow),
    ...(acc.payments ? { payments: cur.payments.map(payRow), paid: cur.paid, salary: cur.salary, remaining: cur.remaining } : {}) });
  return queueHtml(`كشف ${emp.name}`, html, user);
}
async function printSettlement(id, user) {
  const x = await getSettlement(id, user);
  const html = sheetHtml({ brand: await brandName(), title: 'تصفية موظف', emp: { name: x.employeeName, jobTitle: x.jobTitle, section: x.section }, from: x.from, to: x.to,
    summary: x.summary || {}, shifts: x.shifts || [], payments: x.payments, paid: x.paid, salary: x.salary, remaining: x.remaining, number: x.number, byName: x.byName, note: x.note });
  return queueHtml(`تصفية #${x.number} ${x.employeeName}`, html, user);
}
/** تقرير الدوام لكل الموظفين في فترة. */
async function printReport(query, user) {
  const r = await report(query, user);
  const rows = r.rows.map((x) => `<tr><td>${hEsc(x.name)}</td><td class="num">${x.days}${x.offDays ? `/${x.offDays}ع` : ''}</td><td class="num">${hm(x.workedMinutes)}</td><td class="num">${x.breakCount}·${x.breakMinutes}</td></tr>`).join('');
  const body = `<h1>${hEsc(await brandName())}</h1><div class="sub">تقرير الدوام</div>
    <div class="row"><span>الفترة</span><span>${r.from} ← ${r.to}</span></div><hr>
    <table><thead><tr><th>الموظف</th><th class="num">أيام</th><th class="num">ساعات</th><th class="num">استراحة</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="row total"><span>مجموع الساعات</span><span>${hm(r.totals.workedMinutes)}</span></div>
    <div class="row"><span>الاستراحات</span><span>${r.totals.breakCount} · ${r.totals.breakMinutes} د</span></div>
    <div class="foot">ع = عطلة · طُبع ${hEsc(dFull.format(new Date()))} ${hEsc(tFmt.format(new Date()))}</div>`;
  return queueHtml(`تقرير الدوام ${r.from}`, receipts.page('تقرير الدوام', receipts.logoDataUri(), body), user);
}

module.exports = {
  // أدوات
  ipAllowed, normIp, weakPin, ammanDay, FLAG_LABELS,
  // إعدادات وأجهزة
  getConfig, publicConfig, updateConfig, listDevices, createDevice, repairDevice, revokeDevice, pairDevice, kioskAuth,
  // PIN
  setPin, unlockPin, changePin,
  // جهاز الحضور
  kioskState, punch,
  // البريك والآن
  startBreak, endBreak, addPastBreak, deleteBreak, live,
  // المدير
  closeShift, editShift, createManual, reviewShift, exceptions,
  // تقارير
  report, employeeRecord, photo, supervisorCandidates,
  // الصلاحيات، العطل، التنبيهات، التصفية، الطباعة، صفحة الموظف
  access, accessOf, markDay, deleteDay, checkAlerts, start, employeeFull, employeesOverview, settle, getSettlement,
  printEmployee, printSettlement, printReport, sheetHtml,
};
