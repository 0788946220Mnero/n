const Category = require('../models/Category');

// GET /api/categories
const getCategories = async (req, res) => {
  const categories = await Category.find().sort({ order: 1 });
  res.json(categories);
};

// GET /api/categories/:id
const getCategory = async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ message: 'التصنيف غير موجود' });
  res.json(category);
};

// POST /api/categories
const createCategory = async (req, res) => {
  const { nameAr, nameEn, isVisible, order } = req.body;
  const image = req.file ? req.file.path : '';

  const category = await Category.create({ nameAr, nameEn, isVisible, order, image });
  res.status(201).json(category);
};

// PUT /api/categories/:id
const updateCategory = async (req, res) => {
  const updateData = { ...req.body };
  if (req.file) updateData.image = req.file.path;

  const category = await Category.findByIdAndUpdate(req.params.id, updateData, {
    new: true,
    runValidators: true,
  });
  if (!category) return res.status(404).json({ message: 'التصنيف غير موجود' });
  res.json(category);
};

// DELETE /api/categories/:id
const deleteCategory = async (req, res) => {
  const category = await Category.findByIdAndDelete(req.params.id);
  if (!category) return res.status(404).json({ message: 'التصنيف غير موجود' });
  res.json({ message: 'تم حذف التصنيف بنجاح' });
};

// PUT /api/categories/reorder  -> body: { items: [{ id, order }, ...] }
const reorderCategories = async (req, res) => {
  const { items } = req.body;
  await Promise.all(
    items.map((item) => Category.findByIdAndUpdate(item.id, { order: item.order }))
  );
  res.json({ message: 'تم تحديث الترتيب بنجاح' });
};

module.exports = {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
};
