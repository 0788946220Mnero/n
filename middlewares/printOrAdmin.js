// يسمح بالوصول لمسارات الطباعة إمّا ببطاقة الطباعة (x-print-token) — لأي برنامج طابعة خارجي —
// أو بتسجيل دخول لوحة التحكم (JWT). هكذا تستطيع لوحة التحكم نفسها إدارة طابور الطباعة.
const { protect } = require('./auth');

const printOrAdmin = (req, res, next) => {
  const token = req.headers['x-print-token'];
  if (token && process.env.PRINT_TOKEN && token === process.env.PRINT_TOKEN) {
    return next();
  }
  return protect(req, res, next);
};

module.exports = { printOrAdmin };
