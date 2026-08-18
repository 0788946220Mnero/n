const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
} = require('../controllers/userController');

// إدارة مستخدمي الإدارة — للمدير ومدير النظام فقط
router.get('/', protect, authorize('admin', 'manager'), getUsers);
router.get('/:id', protect, authorize('admin', 'manager'), getUser);
router.post('/', protect, authorize('admin'), createUser);
router.put('/:id', protect, authorize('admin'), updateUser);
router.delete('/:id', protect, authorize('admin'), deleteUser);

module.exports = router;
