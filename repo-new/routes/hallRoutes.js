const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const hall = require('../services/hallService');

/*
 * /api/hall — الصالة:
 *   hall:use     النادل (تابلت/جوال): الطاولات، إرسال جولة للمطبخ، طلب الحساب، نقل طاولة
 *   hall:manage  الكاشير/المدير: إعداد الطاولات، إلغاء صنف، قبض الحساب وإغلاقه، إلغاء حساب فارغ
 */
const use = requirePermission('hall:use', 'hall:manage');
const manage = requirePermission('hall:manage');
const fail = (res, e) => res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'خطأ في الخادم' });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { if (!e.status) console.error('hall:', e); fail(res, e); });
const roundLimiter = rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'طلبات كثيرة خلال دقيقة' } });

router.use(protect);

router.get('/tables', use, wrap(async (req, res) => {
  res.json({ success: true, tables: await hall.listTables({ all: req.query.all === '1' }) });
}));
router.post('/tables', manage, wrap(async (req, res) => {
  if (req.body && req.body.from !== undefined) return res.status(201).json({ success: true, created: await hall.createRange(req.body) });
  res.status(201).json({ success: true, table: await hall.createTable(req.body || {}) });
}));
router.put('/tables/:id', manage, wrap(async (req, res) => { await hall.updateTable(req.params.id, req.body || {}); res.json({ success: true }); }));
router.delete('/tables/:id', manage, wrap(async (req, res) => { await hall.deleteTable(req.params.id); res.json({ success: true }); }));

router.post('/tables/:id/round', use, roundLimiter, wrap(async (req, res) => {
  const r = await hall.addRound(req.params.id, req.body || {}, req.user);
  res.status(r.duplicate ? 200 : 201).json({ success: true, tab: hall.publicTab(r.tab), job: r.job ? { _id: String(r.job._id), status: r.job.status } : null, duplicate: !!r.duplicate });
}));

router.get('/tabs/:id', use, wrap(async (req, res) => { res.json({ success: true, tab: hall.publicTab(await hall.getTab(req.params.id)) }); }));
router.post('/tabs/:id/bill', use, wrap(async (req, res) => {
  const r = await hall.requestBill(req.params.id, req.user);
  res.json({ success: true, tab: hall.publicTab(r.tab), job: { _id: String(r.job._id) } });
}));
router.post('/tabs/:id/move', use, wrap(async (req, res) => {
  res.json({ success: true, tab: hall.publicTab(await hall.moveTab(req.params.id, req.body && req.body.tableId, req.user)) });
}));
router.post('/tabs/:id/items/:itemId/void', manage, wrap(async (req, res) => {
  res.json({ success: true, tab: hall.publicTab(await hall.voidItem(req.params.id, req.params.itemId, req.body && req.body.reason, req.user)) });
}));
router.post('/tabs/:id/pay', manage, wrap(async (req, res) => {
  const r = await hall.payTab(req.params.id, req.body || {}, req.user);
  res.json({ success: true, order: r.order, tab: hall.publicTab(r.tab) });
}));
router.post('/tabs/:id/void', manage, wrap(async (req, res) => { await hall.voidTab(req.params.id, req.user); res.json({ success: true }); }));

module.exports = router;
