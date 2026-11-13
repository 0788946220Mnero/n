// سكربت لنقل الفئات والمنتجات (القائمة الحالية على الموقع) إلى قاعدة البيانات
// الحقيقية، حتى تصير قابلة للتعديل والحذف والإضافة من لوحة التحكم.
//
// طريقة التشغيل: node seedMenu.js
// (تأكد إن ملف .env عندك فيه MONGO_URI يشير لنفس قاعدة البيانات المتصلة بـ Railway)
//
// السكربت آمن للتشغيل أكثر من مرة: أي فئة أو منتج موجود مسبقاً (بنفس الاسم)
// يتم تجاوزه بدون تكرار.

require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('./models/Category');
const Product = require('./models/Product');

const categoriesData = [
  { key: 'chicken', nameAr: 'شاورما دجاج', nameEn: 'Chicken Shawarma', order: 1 },
  { key: 'meat',    nameAr: 'شاورما لحمة', nameEn: 'Beef Shawarma',    order: 2 },
  { key: 'snack',   nameAr: 'سناك',        nameEn: 'Snacks',           order: 3 },
  { key: 'extras',  nameAr: 'إضافات',      nameEn: 'Extras',           order: 4 },
];

const productsData = [
  { name:'ساندويش شاورما صغير', nameEn:'Small Chicken Shawarma Sandwich', desc:'60 غرام — مثومة + صوص حار + مخلل', price:.75,  cat:'chicken' },
  { name:'ساندويش شاورما كبير', nameEn:'Large Chicken Shawarma Sandwich', desc:'110 غرام — مثومة + صوص حار + مخلل', price:1.20, cat:'chicken' },
  { name:'ساندويش فرنسي بجبنة', nameEn:'French Cheese Sandwich', desc:'110 غرام — خبز فرنسي + جبنة + مثومة', price:1.25, cat:'chicken' },
  { name:'وجبة شاورما عادي', nameEn:'Regular Chicken Shawarma Meal', desc:'8 قطع + بطاطا + مثومة + صوص حار', price:2.15, cat:'chicken' },
  { name:'وجبة شاورما سوبر', nameEn:'Super Chicken Shawarma Meal', desc:'12 قطعة + بطاطا + مثومة + صوص حار', price:2.70, cat:'chicken' },
  { name:'وجبة شاورما دبل', nameEn:'Double Chicken Shawarma Meal', desc:'16 قطعة + بطاطا + مثومة', price:3.40, cat:'chicken' },
  { name:'وجبة شاورما تربل', nameEn:'Triple Chicken Shawarma Meal', desc:'24 قطعة + بطاطا + مثومة', price:4.60, cat:'chicken' },
  { name:'وجبة عائلية 5 أشخاص', nameEn:'Family Meal for 5', desc:'40 قطعة + صحن مقبلات + 3 كولسلو + لتر ماتريكس', price:9.00, cat:'chicken' },
  { name:'وجبة عائلية 7 أشخاص', nameEn:'Family Meal for 7', desc:'56 قطعة + صحن مقبلات + 5 كولسلو + لتر ماتريكس', price:12.00, cat:'chicken' },
  { name:'وجبة عائلية 10 أشخاص', nameEn:'Family Meal for 10', desc:'80 قطعة + 2 صحن + 7 كولسلو + 2L ماتريكس', price:17.50, cat:'chicken' },

  { name:'ساندويش لحمة صغير', nameEn:'Small Beef Shawarma Sandwich', desc:'50 غرام — طحينية + مخلل', price:.75, cat:'meat' },
  { name:'ساندويش لحمة كبير', nameEn:'Large Beef Shawarma Sandwich', desc:'90 غرام — طحينية + مخلل', price:1.30, cat:'meat' },
  { name:'وجبة لحمة عادي', nameEn:'Regular Beef Shawarma Meal', desc:'8 قطع + بطاطا + طحينية', price:2.20, cat:'meat' },
  { name:'وجبة لحمة سوبر', nameEn:'Super Beef Shawarma Meal', desc:'12 قطعة + بطاطا + طحينية', price:2.80, cat:'meat' },
  { name:'وجبة لحمة دبل', nameEn:'Double Beef Shawarma Meal', desc:'16 قطعة + بطاطا + طحينية', price:3.60, cat:'meat' },
  { name:'وجبة لحمة تربل', nameEn:'Triple Beef Shawarma Meal', desc:'24 قطعة + بطاطا + طحينية', price:4.50, cat:'meat' },
  { name:'وجبة عائلية 5 لحمة', nameEn:'Beef Family Meal for 5', desc:'40 قطعة + صحن مقبلات + 3 علب طحينية + عيران', price:10.00, cat:'meat' },
  { name:'وجبة عائلية 7 لحمة', nameEn:'Beef Family Meal for 7', desc:'56 قطعة + صحن مقبلات + 5 علب طحينية + عيران', price:13.25, cat:'meat' },

  { name:'برجر لحمة', nameEn:'Beef Burger', desc:'80 غرام لحمة + شيدر + كوكتيل', price:1.25, cat:'snack' },
  { name:'اسكالوب', nameEn:'Chicken Escalope', desc:'دجاج مقرمش + شيدر + كوكتيل', price:1.25, cat:'snack' },
  { name:'زنجر فرنسي', nameEn:'French Zinger', desc:'زنجر + شيدر + كوكتيل — خبز فرنسي', price:1.75, cat:'snack' },
  { name:'زنجر تورتيلا', nameEn:'Tortilla Zinger', desc:'زنجر + شيدر + كوكتيل — تورتيلا', price:1.75, cat:'snack' },
  { name:'وجبة زنجر تورتيلا', nameEn:'Tortilla Zinger Meal', desc:'زنجر تورتيلا + بطاطا + مثومة + كوكتيل', price:2.70, cat:'snack' },
  { name:'وجبة زنجر فرنسي', nameEn:'French Zinger Meal', desc:'زنجر فرنسي + بطاطا + كولسلو + مثومة', price:2.70, cat:'snack' },
  { name:'وجبة برجر', nameEn:'Burger Meal', desc:'2 برجر + بطاطا + صوص', price:3.00, cat:'snack' },

  { name:'علبة ماتريكس', nameEn:'Matrix Drink Can', desc:'مشروب بارد — عبوة صغيرة', price:.30, cat:'extras' },
  { name:'لتر ماتريكس', nameEn:'Matrix Drink 1L', desc:'مشروب بارد — لتر', price:.60, cat:'extras' },
  { name:'2 لتر ماتريكس', nameEn:'Matrix Drink 2L', desc:'مشروب عائلي', price:1.00, cat:'extras' },
  { name:'علبة مثومة', nameEn:'Garlic Sauce Cup', desc:'صوص ثوم كريمي', price:.50, cat:'extras' },
  { name:'علبة مخلل', nameEn:'Pickles Cup', desc:'مخلل شرحات طازج', price:.50, cat:'extras' },
  { name:'صوص حار', nameEn:'Hot Sauce', desc:'صوص حار منعش', price:.25, cat:'extras' },
  { name:'علبة كولسلو', nameEn:'Coleslaw Cup', desc:'سلطة ملفوف', price:.25, cat:'extras' },
  { name:'ماء صغير', nameEn:'Small Water Bottle', desc:'عبوة ماء صغيرة', price:.25, cat:'extras' },
  { name:'ماء كبير', nameEn:'Large Water Bottle', desc:'عبوة ماء كبيرة', price:.40, cat:'extras' },
];

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ متصل بقاعدة البيانات');

  // 1) إنشاء الفئات (إن لم تكن موجودة مسبقاً بنفس الاسم)
  const categoryIdByKey = {};
  for (const cat of categoriesData) {
    let doc = await Category.findOne({ nameAr: cat.nameAr });
    if (!doc) {
      doc = await Category.create({ nameAr: cat.nameAr, nameEn: cat.nameEn, order: cat.order });
      console.log(`  + تمت إضافة الفئة: ${cat.nameAr}`);
    } else {
      console.log(`  = الفئة موجودة مسبقاً: ${cat.nameAr}`);
    }
    categoryIdByKey[cat.key] = doc._id;
  }

  // 2) إنشاء المنتجات (إن لم يكن يوجد منتج بنفس الاسم مسبقاً)
  let added = 0;
  let skipped = 0;
  for (const p of productsData) {
    const exists = await Product.findOne({ nameAr: p.name });
    if (exists) {
      skipped += 1;
      continue;
    }
    await Product.create({
      nameAr: p.name,
      nameEn: p.nameEn,
      description: p.desc,
      price: p.price,
      category: categoryIdByKey[p.cat],
    });
    added += 1;
  }

  console.log(`✅ تمت إضافة ${added} منتج جديد، وتخطّي ${skipped} منتج موجود مسبقاً.`);
  console.log('✅ الفئات والمنتجات الآن قابلة للتعديل والحذف والإضافة بالكامل من لوحة التحكم.');
  process.exit(0);
};

run().catch((err) => {
  console.error('❌ خطأ أثناء تنفيذ السكربت:', err);
  process.exit(1);
});
