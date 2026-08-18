const Product = require('../models/Product');

// GET /api/products?page=1&limit=10&search=شاورما&category=id&sort=-createdAt
const getProducts = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.category) filter.category = req.query.category;
  if (req.query.isAvailable) filter.isAvailable = req.query.isAvailable === 'true';
  if (req.query.search) {
    filter.$or = [
      { nameAr: { $regex: req.query.search, $options: 'i' } },
      { nameEn: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const sort = req.query.sort || '-createdAt';

  const [products, total] = await Promise.all([
    Product.find(filter).populate('category', 'nameAr nameEn').sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  res.json({
    data: products,
    pagination: {
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
    },
  });
};

// GET /api/products/:id
const getProduct = async (req, res) => {
  const product = await Product.findById(req.params.id).populate('category', 'nameAr nameEn');
  if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });

  product.views += 1;
  await product.save();

  res.json(product);
};

// تحويل الحقول الرقمية الاختيارية القادمة من نموذج FormData (تصل كنص دائماً)
// إلى رقم صحيح أو null إذا تُركت فارغة — لمنع خطأ Mongoose عند حفظ سلسلة فارغة في حقل رقمي
const sanitizeOptionalNumbers = (data) => {
  ['oldPrice', 'stock'].forEach((key) => {
    if (data[key] === '' || data[key] === undefined) {
      data[key] = null;
    } else if (data[key] !== null) {
      data[key] = Number(data[key]);
    }
  });
  return data;
};

// POST /api/products
const createProduct = async (req, res) => {
  const image = req.files?.image?.[0] ? req.files.image[0].path : '';
  const images = req.files?.images ? req.files.images.map((f) => f.path) : [];

  const productData = sanitizeOptionalNumbers({ ...req.body, image, images });
  if (typeof productData.addons === 'string') {
    productData.addons = JSON.parse(productData.addons);
  }

  const product = await Product.create(productData);
  res.status(201).json(product);
};

// PUT /api/products/:id
const updateProduct = async (req, res) => {
  const updateData = sanitizeOptionalNumbers({ ...req.body });

  if (req.files?.image?.[0]) updateData.image = req.files.image[0].path;
  if (req.files?.images) updateData.images = req.files.images.map((f) => f.path);
  if (typeof updateData.addons === 'string') updateData.addons = JSON.parse(updateData.addons);

  const product = await Product.findByIdAndUpdate(req.params.id, updateData, {
    new: true,
    runValidators: true,
  });
  if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
  res.json(product);
};

// DELETE /api/products/:id
const deleteProduct = async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
  res.json({ message: 'تم حذف المنتج بنجاح' });
};


// PATCH /api/products/:id/availability — إيقاف/تفعيل صنف يدوياً (مشغول)
const toggleAvailability = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    if (typeof req.body.isAvailable === 'boolean') product.isAvailable = req.body.isAvailable;
    else product.isAvailable = !product.isAvailable;
    await product.save();
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر تحديث حالة المنتج', error: err.message });
  }
};

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct, toggleAvailability };
