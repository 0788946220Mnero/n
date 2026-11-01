/**
 * أثناء الاختبارات فقط: console.log يُكتب إلى stderr بدل stdout.
 * مُشغّل اختبارات Node يقرأ stdout لكل ملف كرسائل داخلية مُسلسَلة، وأسطر الخادم المطبوعة
 * (👤 أنشأ مستخدماً… 📆 قسط…) قد تتداخل معها فيفشل الملف بخطأ
 * «Unable to deserialize cloned data» بلا علاقة بالكود. السجلات تبقى ظاهرة على stderr.
 */
console.log = (...args) => console.error(...args);
