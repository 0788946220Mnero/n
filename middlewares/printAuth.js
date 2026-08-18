// حماية مسارات طابور الطباعة ببطاقة سرية بسيطة (PRINT_TOKEN).
// برنامج الطابعة المحلي يرسلها في ترويسة x-print-token.
// اضبط في Railway → Variables:  PRINT_TOKEN = قيمة-سرية-طويلة
const printAuth = (req, res, next) => {
  const expected = process.env.PRINT_TOKEN;
  const provided = req.headers['x-print-token'];
  if (!expected) return res.status(500).json({ message: 'PRINT_TOKEN غير مضبوط على الخادم' });
  if (!provided || provided !== expected) return res.status(401).json({ message: 'غير مصرّح: بطاقة الطباعة غير صحيحة' });
  next();
};

module.exports = { printAuth };
