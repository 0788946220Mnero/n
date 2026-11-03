const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const att = require('../services/attendanceService');

/*
 * /api/attendance — الدوام:
 *   /kiosk/*            جهاز الحضور في المطعم (مفتاح الجهاز + شبكة المطعم + PIN الموظف) — بلا حساب مستخدم
 *   attendance:breaks   مسؤول القسم: من على رأس عمله الآن، وتسجيل البريك
 *   attendance:manage   المدير: الأجهزة، رموز PIN، الاستثناءات، تعديل/إغلاق الدوام، الإعدادات
 *   attendance:view     التقارير (عرض فقط)
 */
const fail = (res, e) => res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { if (!e.status) console.error('attendance:', e); fail(res, e); });
const limiter = (max, windowMs = 60 * 1000) => rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'محاولات كثيرة — انتظر قليلاً' } });

// الصلاحية من accessOf: البريك لأي «مدير» ولمن يضيفه المدير مسؤول قسم في الإعدادات، لا من مفتاح الصلاحية وحده
const need = (key) => wrap(async (req, res, next) => {
  const a = await att.access(req.user);
  if (!a[key]) return res.status(403).json({ success: false, message: 'ليس لديك صلاحية للقيام بهذا الإجراء' });
  req.attAccess = a; next();
});
const breaks = need('breaks');
const manage = need('manage');
const view = need('view');
const record = need('view');

/* ═══ جهاز الحضور ═══ */
router.post('/kiosk/pair', limiter(10, 15 * 60 * 1000), wrap(async (req, res) => {
  res.json({ success: true, ...(await att.pairDevice(req.body && req.body.code, req.ip)) });
}));
router.get('/kiosk/state', limiter(60), att.kioskAuth, wrap(async (req, res) => {
  res.json({ success: true, device: { name: req.kiosk.name }, ...(await att.kioskState(req.attCfg)) });
}));
router.post('/kiosk/punch', limiter(30), att.kioskAuth, wrap(async (req, res) => {
  res.json({ success: true, ...(await att.punch(req.body, { req, device: req.kiosk, cfg: req.attCfg })) });
}));
router.post('/kiosk/pin', limiter(20), att.kioskAuth, wrap(async (req, res) => {
  res.json({ success: true, ...(await att.changePin(req.body || {}, { req, device: req.kiosk.name })) });
}));

/* ═══ بحساب مستخدم ═══ */
router.use(protect);

// ماذا يستطيع المستخدم (للوحة: إظهار الرابط والأزرار)
router.get('/access', wrap(async (req, res) => { const a = await att.access(req.user); res.json({ success: true, access: { ...a } }); }));

// صفحة الموظفين: الفترة الجارية منذ آخر تصفية، والتصفيات، والطباعة عبر محطة الطباعة
router.get('/employees', view, wrap(async (req, res) => res.json({ success: true, ...(await att.employeesOverview(req.user, { all: req.query.all === '1' })) })));
router.get('/employees/:id/full', view, wrap(async (req, res) => res.json({ success: true, ...(await att.employeeFull(req.params.id, req.user)) })));
router.post('/employees/:id/settle', view, wrap(async (req, res) => res.status(201).json({ success: true, settlement: await att.settle(req.params.id, req.user, req.body) })));
router.post('/employees/:id/print', view, wrap(async (req, res) => res.json({ success: true, ...(await att.printEmployee(req.params.id, req.user)) })));
router.get('/settlements/:id', view, wrap(async (req, res) => res.json({ success: true, settlement: await att.getSettlement(req.params.id, req.user) })));
router.post('/settlements/:id/print', view, wrap(async (req, res) => res.json({ success: true, ...(await att.printSettlement(req.params.id, req.user)) })));
router.post('/report/print', view, wrap(async (req, res) => res.json({ success: true, ...(await att.printReport(req.body || {}, req.user)) })));

// العطل ونصف الدوام لتاريخ (المدير)
router.post('/days', manage, wrap(async (req, res) => res.status(201).json({ success: true, shift: await att.markDay(req.user, req.body) })));
router.delete('/days/:id', manage, wrap(async (req, res) => { await att.deleteDay(req.params.id, req.user); res.json({ success: true }); }));

// مسؤول القسم
router.get('/live', breaks, wrap(async (req, res) => res.json({ success: true, ...(await att.live(req.user)) })));
router.post('/shifts/:id/breaks/start', breaks, wrap(async (req, res) => res.json({ success: true, shift: await att.startBreak(req.params.id, req.user, req.body) })));
router.post('/shifts/:id/breaks/end', breaks, wrap(async (req, res) => res.json({ success: true, shift: await att.endBreak(req.params.id, req.user) })));
router.post('/shifts/:id/breaks', breaks, wrap(async (req, res) => res.status(201).json({ success: true, shift: await att.addPastBreak(req.params.id, req.user, req.body) })));
router.delete('/shifts/:id/breaks/:breakId', breaks, wrap(async (req, res) => res.json({ success: true, shift: await att.deleteBreak(req.params.id, req.params.breakId, req.user, req.body) })));

// التقارير وسجل الموظف
router.get('/report', view, wrap(async (req, res) => res.json({ success: true, ...(await att.report(req.query, req.user)) })));
router.get('/employees/:id', record, wrap(async (req, res) => res.json({ success: true, ...(await att.employeeRecord(req.params.id, req.query, req.user)) })));

// المدير
router.get('/exceptions', manage, wrap(async (req, res) => res.json({ success: true, ...(await att.exceptions()) })));
router.post('/shifts', manage, wrap(async (req, res) => res.status(201).json({ success: true, shift: await att.createManual(req.user, req.body) })));
router.put('/shifts/:id', manage, wrap(async (req, res) => res.json({ success: true, shift: await att.editShift(req.params.id, req.user, req.body || {}) })));
router.post('/shifts/:id/close', manage, wrap(async (req, res) => res.json({ success: true, shift: await att.closeShift(req.params.id, req.user, req.body || {}) })));
router.post('/shifts/:id/review', manage, wrap(async (req, res) => res.json({ success: true, shift: await att.reviewShift(req.params.id, req.user, req.body) })));
router.get('/photos/:id', manage, wrap(async (req, res) => {
  const p = await att.photo(req.params.id);
  res.setHeader('Content-Type', p.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(p.data);
}));
router.post('/employees/:id/pin', manage, wrap(async (req, res) => res.json({ success: true, ...(await att.setPin(req.params.id, req.body && req.body.pin, req.user)) })));
router.post('/employees/:id/unlock', manage, wrap(async (req, res) => { await att.unlockPin(req.params.id, req.user); res.json({ success: true }); }));

router.get('/devices', manage, wrap(async (req, res) => res.json({ success: true, devices: await att.listDevices(), myIp: att.normIp(req.ip) })));
router.post('/devices', manage, wrap(async (req, res) => res.status(201).json({ success: true, ...(await att.createDevice(req.body, req.user)) })));
router.post('/devices/:id/pair', manage, wrap(async (req, res) => res.json({ success: true, ...(await att.repairDevice(req.params.id, req.user)) })));
router.delete('/devices/:id', manage, wrap(async (req, res) => { await att.revokeDevice(req.params.id, req.user); res.json({ success: true }); }));

router.get('/config', manage, wrap(async (req, res) => res.json({ success: true, config: att.publicConfig(await att.getConfig()), candidates: await att.supervisorCandidates() })));
router.put('/config', manage, wrap(async (req, res) => res.json({ success: true, config: await att.updateConfig(req.body, req.user) })));

module.exports = router;
