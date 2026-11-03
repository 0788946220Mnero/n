const Printer = require('../models/Printer');
const Category = require('../models/Category');
const Product = require('../models/Product');

/*
  ═══════════════════════════════════════════════════════════════
  منطق توجيه الطباعة — المصدر الوحيد للحقيقة.

  السلسلة:  الصنف → تصنيفه → طابعة التصنيف → الطابعة الرئيسية

  لوحة التحكم وتطبيق DiyarPOS يعرضان فقط؛ القرار يُتخذ هنا.
  ═══════════════════════════════════════════════════════════════
*/

const getMainPrinter = () => Printer.findOne({ isMain: true, isActive: true });

// يضمن وجود طابعة رئيسية واحدة فقط
const setMain = async (printerId) => {
  await Printer.updateMany({ _id: { $ne: printerId } }, { $set: { isMain: false } });
  return Printer.findByIdAndUpdate(printerId, { isMain: true, isActive: true }, { new: true });
};

/*
  يوزّع أصناف الطلب على الطابعات.
  يُرجع مصفوفة: [{ printer, items: [...] }]
  الأصناف التي لا يُعرف تصنيفها تذهب للطابعة الرئيسية.
*/
const groupOrderItemsByPrinter = async (items = []) => {
  const main = await getMainPrinter();

  const productIds = items.map((i) => i.product).filter(Boolean);
  const products = await Product.find({ _id: { $in: productIds } }).select('category').lean();
  const productToCategory = new Map(products.map((p) => [String(p._id), String(p.category)]));

  const categories = await Category.find({ _id: { $in: [...new Set(productToCategory.values())] } })
    .select('printer nameAr')
    .lean();
  const categoryToPrinter = new Map(
    categories.map((c) => [String(c._id), c.printer ? String(c.printer) : null])
  );

  const printerIds = [...new Set([...categoryToPrinter.values()].filter(Boolean))];
  const printers = await Printer.find({ _id: { $in: printerIds }, isActive: true }).lean();
  const printerById = new Map(printers.map((p) => [String(p._id), p]));

  const groups = new Map();
  const push = (printer, item) => {
    const key = printer ? String(printer._id) : 'main';
    if (!groups.has(key)) groups.set(key, { printer: printer || main || null, items: [] });
    groups.get(key).items.push(item);
  };

  for (const item of items) {
    const categoryId = productToCategory.get(String(item.product));
    const printerId = categoryId ? categoryToPrinter.get(categoryId) : null;
    const printer = printerId ? printerById.get(printerId) : null;
    push(printer, item); // بلا طابعة قسم → المجموعة الرئيسية
  }

  return [...groups.values()];
};

// خريطة التوجيه لعرضها في لوحة التحكم
const buildRoutingMap = async () => {
  const categories = await Category.find().select('nameAr printer order').sort('order').lean();
  return categories.map((c) => ({
    categoryId: String(c._id),
    categoryName: c.nameAr,
    printerId: c.printer ? String(c.printer) : null,
  }));
};

module.exports = { getMainPrinter, setMain, groupOrderItemsByPrinter, buildRoutingMap };
