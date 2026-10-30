const { wrapAll } = require('../utils/asyncHandler');
const mongoose = require('mongoose');
const Printer = require('../models/Printer');
const Category = require('../models/Category');
const printerService = require('../services/printerService');

const NETWORK = ['LAN', 'WIFI'];

// تنظيف مدخلات الواجهة
const parseBody = (body = {}) => {
  const connectionType = ['WINDOWS', 'USB', 'LAN', 'WIFI'].includes(body.connectionType)
    ? body.connectionType
    : 'WINDOWS';

  return {
    name: String(body.name || '').trim(),
    type: ['THERMAL', 'A4', 'LABEL'].includes(body.type) ? body.type : 'THERMAL',
    connectionType,
    systemName: String(body.systemName || '').trim(),
    address: String(body.address || '').trim(),
    port: Number(body.port) || 9100,
    paperWidth: [58, 80].includes(Number(body.paperWidth)) ? Number(body.paperWidth) : 80,
    copies: Math.min(Math.max(Number(body.copies) || 1, 1), 5),
    autoCut: body.autoCut !== false,
    isActive: body.isActive !== false,
    isMain: !!body.isMain,
  };
};

// تحقق من تماسك بيانات الاتصال
const validate = (data) => {
  if (!data.name) return 'اسم الطابعة مطلوب';
  if (NETWORK.includes(data.connectionType) && !data.address) {
    return 'عنوان IP مطلوب للطابعات الشبكية';
  }
  if (!NETWORK.includes(data.connectionType) && !data.systemName) {
    return 'اسم الطابعة في ويندوز مطلوب للطابعات المحلية';
  }
  return null;
};

// GET /api/printers
const getPrinters = async (req, res) => {
  const printers = await Printer.find().sort({ isMain: -1, name: 1 });
  res.json({ success: true, count: printers.length, data: printers });
};

// POST /api/printers
const createPrinter = async (req, res) => {
  const data = parseBody(req.body);
  const error = validate(data);
  if (error) return res.status(400).json({ success: false, message: error });

  const count = await Printer.countDocuments();
  if (count === 0) data.isMain = true; // أول طابعة تصبح الرئيسية تلقائياً

  const printer = await Printer.create(data);
  if (data.isMain) await printerService.setMain(printer._id);

  console.log(`🖨️ أضاف ${req.user.username} طابعة: ${printer.name} (${printer.connectionType})`);
  res.status(201).json({ success: true, data: await Printer.findById(printer._id) });
};

// PUT /api/printers/:id
const updatePrinter = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: 'معرّف الطابعة غير صالح' });
  }
  const data = parseBody(req.body);
  const error = validate(data);
  if (error) return res.status(400).json({ success: false, message: error });

  const printer = await Printer.findByIdAndUpdate(req.params.id, data, { new: true });
  if (!printer) return res.status(404).json({ success: false, message: 'الطابعة غير موجودة' });

  if (data.isMain) await printerService.setMain(printer._id);
  res.json({ success: true, data: await Printer.findById(printer._id) });
};

// DELETE /api/printers/:id
const deletePrinter = async (req, res) => {
  const printer = await Printer.findById(req.params.id);
  if (!printer) return res.status(404).json({ success: false, message: 'الطابعة غير موجودة' });

  // التصنيفات المرتبطة تعود للطابعة الرئيسية — الواجهة تعرض هذا العدد
  const result = await Category.updateMany({ printer: printer._id }, { $set: { printer: null } });
  const unlinkedCategories = result.modifiedCount || 0;

  const wasMain = printer.isMain;
  await printer.deleteOne();

  // إن حُذفت الرئيسية نرقّي أول طابعة مفعّلة مكانها حتى لا يبقى النظام بلا وجهة
  if (wasMain) {
    const next = await Printer.findOne({ isActive: true }).sort('name');
    if (next) {
      await printerService.setMain(next._id);
      console.log(`⭐ الطابعة الرئيسية الجديدة: ${next.name}`);
    }
  }

  console.log(`🗑️ حذف ${req.user.username} الطابعة: ${printer.name} (فُكّ ربط ${unlinkedCategories} تصنيف)`);
  res.json({ success: true, message: 'تم حذف الطابعة', unlinkedCategories });
};

// PATCH /api/printers/:id/main
const setMainPrinter = async (req, res) => {
  const printer = await Printer.findById(req.params.id);
  if (!printer) return res.status(404).json({ success: false, message: 'الطابعة غير موجودة' });

  const updated = await printerService.setMain(printer._id);
  res.json({ success: true, data: updated, message: `تم تعيين ${updated.name} كطابعة رئيسية` });
};

// PATCH /api/printers/:id/active
const togglePrinterActive = async (req, res) => {
  const printer = await Printer.findById(req.params.id);
  if (!printer) return res.status(404).json({ success: false, message: 'الطابعة غير موجودة' });

  const isActive = typeof req.body.isActive === 'boolean' ? req.body.isActive : !printer.isActive;

  // لا نسمح بتعطيل الرئيسية إلا إن وُجد بديل
  if (!isActive && printer.isMain) {
    const alternative = await Printer.findOne({ _id: { $ne: printer._id }, isActive: true });
    if (!alternative) {
      return res.status(400).json({
        success: false,
        message: 'لا يمكن تعطيل الطابعة الرئيسية الوحيدة. فعّل طابعة أخرى أولاً.',
      });
    }
    await printerService.setMain(alternative._id);
  }

  printer.isActive = isActive;
  await printer.save();
  res.json({ success: true, data: printer });
};

// GET /api/printers/routing — خريطة التصنيف ← الطابعة
const getRouting = async (req, res) => {
  const [data, mainPrinter] = await Promise.all([
    printerService.buildRoutingMap(),
    printerService.getMainPrinter(),
  ]);
  res.json({ success: true, data, mainPrinter: mainPrinter || null });
};

// PATCH /api/printers/routing/:categoryId — ربط تصنيف بطابعة (أو فكّه)
const setCategoryPrinter = async (req, res) => {
  const { categoryId } = req.params;
  const { printerId } = req.body;

  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return res.status(400).json({ success: false, message: 'معرّف التصنيف غير صالح' });
  }

  if (printerId) {
    const printer = await Printer.findById(printerId);
    if (!printer) return res.status(404).json({ success: false, message: 'الطابعة غير موجودة' });
  }

  const category = await Category.findByIdAndUpdate(
    categoryId,
    { printer: printerId || null },
    { new: true }
  );
  if (!category) return res.status(404).json({ success: false, message: 'التصنيف غير موجود' });

  res.json({ success: true, data: { categoryId, printerId: printerId || null } });
};

module.exports = wrapAll({
  getPrinters,
  createPrinter,
  updatePrinter,
  deletePrinter,
  setMainPrinter,
  togglePrinterActive,
  getRouting,
  setCategoryPrinter,
});
