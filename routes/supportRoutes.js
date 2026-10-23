const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const { requireCustomer } = require('../middlewares/phoneAuth');
const { wrapAll } = require('../utils/asyncHandler');
const c = wrapAll(require('../controllers/supportController'));

// «تواصل مع فريق العمل» — الزبون برقم هاتفه (توكن type:'customer')
router.get('/me', requireCustomer, c.getMine);
router.get('/me/unread', requireCustomer, c.myUnread);
router.post('/me/messages', requireCustomer, c.sendMine);

// الطاقم: من يملك «رسائل الزبائن» (support:reply)
const staff = [protect, requirePermission('support:reply')];
router.get('/unread', ...staff, c.staffUnread);
router.get('/threads', ...staff, c.listThreads);
router.get('/threads/:id', ...staff, c.getThread);
router.post('/threads/:id/messages', ...staff, c.reply);
router.patch('/threads/:id', ...staff, c.setStatus);

module.exports = router;
