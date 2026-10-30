/**
 * قوالب الطباعة (HTML بعرض 80 ملم) — تُطبع عبر تطبيق المحطة على ويندوز بأي طابعة حرارية
 * مثبّتة كطابعة افتراضية. HTML يدعم العربية والشعار بلا مشاكل ترميز ESC/POS.
 */
const fs = require('fs');
const path = require('path');

/** الشعار مضمّن داخل الورقة (رمادي عالي التباين يناسب الطابعة الحرارية) — لا يحتاج إنترنت عند الرسم. */
let logoCache = null;
function logoDataUri() {
  if (logoCache !== null) return logoCache;
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'assets', 'print-logo.png'));
    logoCache = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (_) { logoCache = ''; }
  return logoCache;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fils = (n) => `${Number(n || 0).toLocaleString('en-US')} قرش`;
const km = (n) => `${Number(n || 0).toFixed(2)} كم`;
const when = (d) => new Date(d || Date.now()).toLocaleString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman' });

const BASE_CSS = `
  @page { size: 80mm auto; margin: 2mm; }
  * { box-sizing: border-box; }
  body { width: 72mm; margin: 0 auto; font-family: Tahoma, Arial, sans-serif; font-size: 13px; color: #000; direction: rtl; }
  .logo { display: block; width: 36mm; margin: 0 auto 4px; }
  h1 { font-size: 17px; text-align: center; margin: 2px 0; }
  .sub { text-align: center; font-size: 11px; margin-bottom: 6px; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; padding: 2px 0; }
  .row b { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 3px 2px; border-bottom: 1px solid #000; text-align: right; }
  th { font-weight: 700; }
  td.num, th.num { text-align: left; white-space: nowrap; }
  .total { font-size: 16px; font-weight: 800; }
  .foot { text-align: center; font-size: 11px; margin-top: 8px; }
`;

function page(title, logoUrl, body) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>${BASE_CSS}</style></head><body>
  ${logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="">` : ''}
  ${body}</body></html>`;
}

/** كشف أسعار المتجر حسب المناطق. */
function priceSheetHtml({ brand, logoUrl, storeName, storeLocation, sheet, settings }) {
  const rows = sheet.map((r) => `<tr><td>${esc(r.areaName)}</td><td class="num">${km(r.km)}</td><td class="num">${fils(r.estimateFils)}</td></tr>`).join('');
  const body = `
    <h1>${esc(brand)}</h1>
    <div class="sub">كشف أسعار التوصيل</div>
    <div class="row"><b>المتجر</b><span>${esc(storeName)}</span></div>
    <div class="row"><span>الموقع</span><span dir="ltr">${storeLocation ? `${storeLocation.lat.toFixed(5)}, ${storeLocation.lng.toFixed(5)}` : '—'}</span></div>
    <div class="row"><span>التاريخ</span><span>${esc(when())}</span></div>
    <hr>
    <table><thead><tr><th>المنطقة</th><th class="num">المسافة</th><th class="num">السعر</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">لا توجد مناطق مفعّلة</td></tr>'}</tbody></table>
    <hr>
    <div style="text-align:center;margin-top:6px">${stampSvg({ brand, mono: true, size: 100 })}</div>
    <div class="foot">فتحة العداد ${fils(settings.meterFlagFils)} + ${fils(settings.perKmFils)} لكل كم هوائي<br>
    السعر تقديري حسب مركز المنطقة، والنهائي يُحسب عند التسليم</div>`;
  return page(`كشف أسعار ${storeName}`, logoUrl, body);
}

/** فاتورة طلب توصيل من الكول سنتر. */
function invoiceHtml({ brand, logoUrl, invoiceNo, storeName, areaName, customerName, customerPhone, customerLocation, stops, estimateFils, operatorName, meterFlagFils, perKmFils, printedAt }) {
  const mapLink = customerLocation ? `https://www.google.com/maps?q=${customerLocation.lat},${customerLocation.lng}` : '';
  const list = Array.isArray(stops) && stops.length ? stops : null;
  const customers = list
    ? list.map((s, i) => `
    <div class="row"><b>${list.length > 1 ? `الزبون ${i + 1}` : 'الزبون'}</b><span>${esc(s.name || '—')}</span></div>
    <div class="row"><span>الهاتف</span><span dir="ltr">${esc(s.phone || '—')}</span></div>
    <div class="row"><span>المنطقة</span><span>${esc(s.areaName || '—')}</span></div>
    ${Number.isFinite(s.lat) ? `<div class="row"><span>الموقع</span><span dir="ltr" style="font-size:10px">${esc(`https://www.google.com/maps?q=${s.lat},${s.lng}`)}</span></div>` : ''}
    ${s.note ? `<div class="row"><span>ملاحظة</span><span>${esc(s.note)}</span></div>` : ''}`).join('<hr>')
    : null;
  const body = `
    <h1>${esc(brand)}</h1>
    <div class="sub">فاتورة توصيل</div>
    <div class="row"><b>رقم الفاتورة</b><span dir="ltr">${esc(invoiceNo)}</span></div>
    <div class="row"><span>التاريخ</span><span>${esc(when(printedAt))}</span></div>
    <hr>
    <div class="row"><b>المتجر</b><span>${esc(storeName)}</span></div>
    ${customers ? `<hr>${customers}` : `<div class="row"><b>المنطقة</b><span>${esc(areaName)}</span></div>
    <hr>
    <div class="row"><b>الزبون</b><span>${esc(customerName || '—')}</span></div>
    <div class="row"><b>الهاتف</b><span dir="ltr">${esc(customerPhone || '—')}</span></div>
    ${mapLink ? `<div class="row"><span>الموقع</span><span dir="ltr" style="font-size:10px">${esc(mapLink)}</span></div>` : ''}`}
    <hr>
    <table><tbody>
      <tr><td>فتحة العداد</td><td class="num">${fils(meterFlagFils)}</td></tr>
      <tr><td>سعر الكم</td><td class="num">${fils(perKmFils)}</td></tr>
    </tbody></table>
    <div class="row total"><span>التقدير</span><span>${fils(estimateFils)}</span></div>
    <hr>
    <div class="row"><span>الموظف</span><span>${esc(operatorName || '—')}</span></div>
    <div class="foot">السعر التقديري، والنهائي يُحسب عند التسليم<br>شكراً لتعاملكم معنا</div>`;
  return page(`فاتورة ${invoiceNo}`, logoUrl, body);
}

/* ═══════════════ وثائق الشركة: الختم المعتمد، A4، التصاريح، السندات، الكشوف ═══════════════ */

/** الشعار الملوّن (للورق العادي A4). */
let colorLogo = null;
function colorLogoDataUri() {
  if (colorLogo !== null) return colorLogo;
  try { colorLogo = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'assets', 'logo.png')).toString('base64')}`; }
  catch (_) { colorLogo = logoDataUri(); }
  return colorLogo;
}

/**
 * ختم الشركة المعتمد (SVG): دائرتان، اسم الشركة على المحيط، «معتمد» والتاريخ في الوسط.
 * mono = أسود للطابعة الحرارية، وإلا أزرق الختم المعتاد.
 */
function stampSvg({ brand = 'شركة البراق', date = new Date(), mono = false, size = 130 } = {}) {
  const c = mono ? '#000' : '#1d3f8f';
  const d = new Date(date).toLocaleDateString('en-GB', { timeZone: 'Asia/Amman' });
  const ring = `${brand} للتوصيل • عمّان — الأردن •`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200" style="transform:rotate(-8deg)">
  <defs><path id="ring" d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0"/></defs>
  <g fill="none" stroke="${c}" opacity=".88"><circle cx="100" cy="100" r="94" stroke-width="5"/><circle cx="100" cy="100" r="60" stroke-width="2.5"/></g>
  <text fill="${c}" font-family="Tahoma,Arial" font-size="17" font-weight="700" opacity=".9"><textPath href="#ring" startOffset="0">${esc(ring)}</textPath></text>
  <text x="100" y="94" text-anchor="middle" fill="${c}" font-family="Tahoma,Arial" font-size="28" font-weight="800" opacity=".92">معتمد</text>
  <text x="100" y="122" text-anchor="middle" fill="${c}" font-family="Tahoma,Arial" font-size="15" opacity=".9">${esc(d)}</text>
</svg>`;
}

const A4_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Tahoma, Arial, sans-serif; color: #111; direction: rtl; font-size: 13px; }
  .head { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #8A1620; padding-bottom: 10px; margin-bottom: 14px; }
  .head img { width: 70px; height: 70px; object-fit: contain; }
  .head h1 { margin: 0; font-size: 22px; color: #8A1620; }
  .head .sub { color: #555; font-size: 13px; }
  .title { font-size: 19px; font-weight: 800; text-align: center; margin: 6px 0 14px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: right; }
  th { background: #f3f4f6; }
  td.num, th.num { text-align: left; white-space: nowrap; direction: ltr; }
  tfoot td { font-weight: 800; background: #fafafa; }
  .sign { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 28px; }
  .sign .line { border-top: 1px solid #333; width: 200px; text-align: center; padding-top: 4px; color: #444; }
  .foot { margin-top: 18px; font-size: 11px; color: #666; text-align: center; }
`;

function a4Page(title, body, { brand = 'شركة البراق', logoUrl = colorLogoDataUri() } = {}) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>${A4_CSS}</style></head><body>
  <div class="head">${logoUrl ? `<img src="${esc(logoUrl)}" alt="">` : ''}<div><h1>${esc(brand)}</h1><div class="sub">للتوصيل — عمّان، الأردن</div></div></div>
  ${body}</body></html>`;
}

/** كشف أسعار المتجر حسب مراكز المناطق — A4 بالشعار والختم المعتمد. */
function priceSheetA4Html({ brand, storeName, storePhone, storeLocation, sheet, settings }) {
  const rows = sheet.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(r.areaName)}</td><td class="num">${km(r.km)}</td><td class="num">${fils(r.estimateFils)}</td></tr>`).join('');
  return a4Page(`كشف أسعار ${storeName}`, `
    <div class="title">كشف أسعار التوصيل حسب المناطق</div>
    <div class="meta">
      <div><b>المتجر:</b> ${esc(storeName)}</div><div><b>الهاتف:</b> <span dir="ltr">${esc(storePhone || '—')}</span></div>
      <div><b>موقع المتجر:</b> <span dir="ltr">${storeLocation ? `${storeLocation.lat.toFixed(5)}, ${storeLocation.lng.toFixed(5)}` : '—'}</span></div>
      <div><b>تاريخ الإصدار:</b> ${esc(when())}</div>
    </div>
    <table><thead><tr><th class="num">#</th><th>المنطقة (المركز)</th><th class="num">المسافة الهوائية</th><th class="num">سعر التوصيل التقديري</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">لا توجد مناطق مفعّلة</td></tr>'}</tbody></table>
    <p style="margin-top:12px">التسعير: فتحة العداد <b>${fils(settings.meterFlagFils)}</b> + <b>${fils(settings.perKmFils)}</b> لكل كيلومتر هوائي من المتجر.
    السعر أعلاه تقديري حتى مركز المنطقة، والنهائي يُحسب عند التسليم من موقع الزبون الفعلي.</p>
    <div class="sign"><div class="line">توقيع المتجر</div><div>${stampSvg({ brand })}</div><div class="line">إدارة ${esc(brand)}</div></div>
    <div class="foot">وثيقة صادرة عن ${esc(brand)} — صالحة حتى تغيير موقع المتجر أو الأسعار</div>`, { brand });
}

/** تصريح سائق — A4 (يُقص كبطاقة) بالشعار والختم. */
function permitHtml({ brand, driver }) {
  const card = `
    <div style="border:3px solid #8A1620;border-radius:16px;padding:18px;max-width:560px;margin:0 auto;position:relative">
      <div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #D4A017;padding-bottom:8px">
        <img src="${colorLogoDataUri()}" style="width:64px;height:64px;object-fit:contain" alt="">
        <div><div style="font-size:20px;font-weight:800;color:#8A1620">${esc(brand)}</div><div style="color:#555">تصريح سائق توصيل</div></div>
        <div style="margin-inline-start:auto;text-align:left;direction:ltr;font-weight:800;font-size:16px">${esc(driver.permitNo)}</div>
      </div>
      <table style="margin-top:12px">
        <tr><th style="width:38%">الاسم</th><td style="font-size:17px;font-weight:700">${esc(driver.name)}</td></tr>
        <tr><th>الهاتف</th><td dir="ltr" style="text-align:right">${esc(driver.phone)}</td></tr>
        ${driver.nationalId ? `<tr><th>الرقم الوطني</th><td dir="ltr" style="text-align:right">${esc(driver.nationalId)}</td></tr>` : ''}
        <tr><th>المركبة</th><td>${esc(driver.vehicle || '—')}${driver.plate ? ` · لوحة <span dir="ltr">${esc(driver.plate)}</span>` : ''}</td></tr>
        <tr><th>تاريخ الإصدار</th><td>${esc(new Date(driver.permitIssuedAt).toLocaleDateString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman' }))}</td></tr>
        <tr><th>صالح حتى</th><td><b>${esc(new Date(driver.permitExpiresAt).toLocaleDateString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman' }))}</b></td></tr>
      </table>
      <p style="margin:10px 0 0">يُصرَّح لحامل هذا التصريح بالعمل سائقاً لدى ${esc(brand)} لتوصيل الطلبات من المتاجر المتعاقدة،
      ويُرجى من الجهات المعنية تسهيل مهمته. يُلغى التصريح بانتهاء مدته أو بإيقاف السائق.</p>
      <div class="sign" style="margin-top:14px"><div class="line">توقيع السائق</div><div>${stampSvg({ brand, size: 120 })}</div><div class="line">المدير المسؤول</div></div>
    </div>`;
  return a4Page(`تصريح ${driver.name}`, `<div class="title">تصريح سائق</div>${card}`, { brand });
}

/** سند قبض (حراري): السائق دفع حصة الشركة، أو المتجر دفع للشركة. */
function paymentReceiptHtml({ brand, s, balanceAfterFils }) {
  return page(`سند قبض ${s.receiptNo}`, logoDataUri(), `
    <h1>${esc(brand)}</h1><div class="sub">سند قبض</div>
    <div class="row"><b>رقم السند</b><span dir="ltr">${esc(s.receiptNo)}</span></div>
    <div class="row"><span>التاريخ</span><span>${esc(when(s.createdAt))}</span></div>
    <hr>
    <div class="row"><b>${s.party === 'driver' ? 'استلمنا من السائق' : 'استلمنا من المتجر'}</b><span>${esc(s.partyName)}</span></div>
    <div class="row total"><span>المبلغ</span><span>${fils(s.amountFils)}</span></div>
    <div class="row"><span>البيان</span><span>${esc(s.note || (s.party === 'driver' ? 'حصة الشركة من التوصيلات' : 'دفعة'))}</span></div>
    ${balanceAfterFils != null ? `<div class="row"><b>المتبقي عليه</b><span>${fils(balanceAfterFils)}</span></div>` : ''}
    <hr>
    <div class="row"><span>المستلم</span><span>${esc(s.byName || '—')}</span></div>
    <div style="text-align:center;margin-top:6px">${stampSvg({ brand, mono: true, size: 110 })}</div>
    <div class="foot">شكراً لكم</div>`);
}

/** وصل توصيل (حراري) لكل رحلة مكتملة. */
function tripReceiptHtml({ brand, t, viewer = 'driver' }) {
  const p = t.pricing || {};
  const stops = (t.stops || []).map((x, i) => `<div class="row"><span>${t.stops.length > 1 ? `${i + 1}. ` : ''}${esc(x.name || x.areaName)}</span><span dir="ltr">${esc(x.phone || '')}</span></div>
    <div class="row"><span>${esc(x.areaName)}</span><span>${x.legKm != null ? km(x.legKm) : ''}</span></div>`).join('');
  return page(`وصل ${t.receiptNo || ''}`, logoDataUri(), `
    <h1>${esc(brand)}</h1><div class="sub">وصل توصيل</div>
    <div class="row"><b>رقم الوصل</b><span dir="ltr">${esc(t.receiptNo || String(t._id).slice(-8).toUpperCase())}</span></div>
    <div class="row"><span>التاريخ</span><span>${esc(when(t.completedAt || t.requestedAt))}</span></div>
    <hr>
    <div class="row"><b>المتجر</b><span>${esc(t.storeName)}</span></div>
    <div class="row"><b>السائق</b><span>${esc(t.driverName || '—')}</span></div>
    ${t.source && t.source.orderNumber ? `<div class="row"><span>طلب المطعم</span><span dir="ltr">${esc(t.source.orderNumber)}</span></div>` : ''}
    <hr>${stops}<hr>
    <div class="row"><span>المسافة الهوائية</span><span>${km(t.km)}</span></div>
    <div class="row"><span>فتحة العداد</span><span>${fils(p.meterFlagFils)}</span></div>
    <div class="row"><span>المسافة × ${fils(p.perKmFils)}</span><span>${fils(p.distanceFils)}</span></div>
    <div class="row total"><span>على المتجر</span><span>${fils(p.storeChargeFils)}</span></div>
    ${viewer === 'admin' ? `<div class="row"><span>للسائق</span><span>${fils(p.driverFils)}</span></div><div class="row"><b>حصة الشركة على السائق</b><span>${fils(p.companyFils)}</span></div>` : ''}
    <div style="text-align:center;margin-top:6px">${stampSvg({ brand, mono: true, size: 96 })}</div>`);
}

/** كشف جرد السائق (حراري): التوصيلات، ما حصّله، أجرته، حصة الشركة عليه، ما دفعه، والرصيد. */
function driverStatementHtml({ brand, driver, l, from, to }) {
  const rows = (l.items || []).slice(0, 40).map((r) => `<tr><td>${esc(r.storeName)}</td><td class="num">${km(r.km)}</td><td class="num">${fils(r.companyFils)}</td></tr>`).join('');
  return page(`جرد ${driver.name}`, logoDataUri(), `
    <h1>${esc(brand)}</h1><div class="sub">كشف جرد سائق</div>
    <div class="row"><b>السائق</b><span>${esc(driver.name)}</span></div>
    <div class="row"><span>الفترة</span><span>${esc(from || 'البداية')} ← ${esc(to || 'اليوم')}</span></div>
    <hr>
    <div class="row"><span>التوصيلات</span><span>${l.trips}</span></div>
    <div class="row"><span>الكيلومترات</span><span>${km(l.km)}</span></div>
    <div class="row"><span>حصّل من المتاجر</span><span>${fils(l.storeChargeFils)}</span></div>
    <div class="row"><span>أجرته</span><span>${fils(l.driverFils)}</span></div>
    <div class="row"><b>حصة الشركة عليه</b><span>${fils(l.companyFils)}</span></div>
    <div class="row"><span>دفع للشركة</span><span>${fils(l.paidFils)}</span></div>
    <div class="row total"><span>المتبقي عليه (الكل)</span><span>${fils(l.balanceFils)}</span></div>
    ${rows ? `<hr><table><thead><tr><th>المتجر</th><th class="num">كم</th><th class="num">للشركة</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <div style="text-align:center;margin-top:6px">${stampSvg({ brand, mono: true, size: 96 })}</div>`);
}

/** كشف حساب المتجر — A4 بالشعار والختم. */
function storeStatementHtml({ brand, store, l, from, to }) {
  const rows = (l.items || []).map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(when(r.completedAt))}</td><td>${esc(r.areaName)}</td><td>${esc(r.driverName || '')}</td>
    <td class="num">${km(r.km)}</td><td class="num">${fils(r.storeChargeFils)}</td></tr>`).join('');
  return a4Page(`كشف حساب ${store.name}`, `
    <div class="title">كشف حساب متجر</div>
    <div class="meta"><div><b>المتجر:</b> ${esc(store.name)}</div><div><b>الهاتف:</b> <span dir="ltr">${esc(store.phone || '')}</span></div>
      <div><b>الفترة:</b> ${esc(from || 'البداية')} ← ${esc(to || 'اليوم')}</div><div><b>تاريخ الإصدار:</b> ${esc(when())}</div></div>
    <table><thead><tr><th class="num">#</th><th>التاريخ</th><th>المنطقة</th><th>السائق</th><th class="num">كم</th><th class="num">أجرة التوصيل</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">لا توصيلات في هذه الفترة</td></tr>'}</tbody>
      <tfoot><tr><td colspan="4">المجموع: ${l.trips} توصيلة</td><td class="num">${km(l.km)}</td><td class="num">${fils(l.storeChargeFils)}</td></tr>
      ${l.paidFils ? `<tr><td colspan="5">مدفوع للشركة</td><td class="num">${fils(l.paidFils)}</td></tr>` : ''}</tfoot></table>
    <div class="sign"><div class="line">توقيع المتجر</div><div>${stampSvg({ brand })}</div><div class="line">محاسب ${esc(brand)}</div></div>`, { brand });
}

module.exports = {
  priceSheetHtml, invoiceHtml, esc, logoDataUri, colorLogoDataUri, stampSvg,
  priceSheetA4Html, permitHtml, paymentReceiptHtml, tripReceiptHtml, driverStatementHtml, storeStatementHtml,
};
