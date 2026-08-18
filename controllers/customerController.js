const Customer = require('../models/Customer');

const getCustomers = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.search) {
    filter.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { phone: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const [customers, total] = await Promise.all([
    Customer.find(filter).sort('-lastOrderAt').skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);

  res.json({ data: customers, pagination: { total, page, pages: Math.ceil(total / limit), limit } });
};

const updateCustomer = async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!customer) return res.status(404).json({ message: 'العميل غير موجود' });
  res.json(customer);
};

// PATCH /api/customers/:id/verify — توثيق رقم العميل يدوياً
const verifyCustomer = async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { verified: true, verifiedAt: new Date(), verifiedBy: (req.user && req.user.name) || '' },
    { new: true }
  );
  if (!customer) return res.status(404).json({ message: 'العميل غير موجود' });
  res.json({ success: true, customer });
};

// PATCH /api/customers/:id/unverify — إلغاء التوثيق
const unverifyCustomer = async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { verified: false, verifiedAt: null, verifiedBy: '' },
    { new: true }
  );
  if (!customer) return res.status(404).json({ message: 'العميل غير موجود' });
  res.json({ success: true, customer });
};

module.exports = { getCustomers, updateCustomer, verifyCustomer, unverifyCustomer };
