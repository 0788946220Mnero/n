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

/* الوصل الحراري: الطابعة الحرارية تطبع نقاطاً سوداء فقط (203 نقطة/إنش) — الخط الرفيع الصغير
   تضيع نقاطه («شركة» تُطبع «سركه»). لذلك: خط عريض كبير، أسود خالص، بلا رمادي، وشعار بعرض الورقة.
   @page بلا هوامش: نافذة طباعة المتصفح لا تضيف التاريخ والعنوان، والوصل لا ينقسم لصفحتين. */
const BASE_CSS = `
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: 76mm; padding: 2mm 3mm 4mm; margin: 0 auto; font-family: Arial, Tahoma, 'Segoe UI', sans-serif;
    font-size: 17px; line-height: 1.45; font-weight: 700; color: #000; direction: rtl;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .logo { display: block; width: 66mm; max-width: 100%; margin: 0 auto 1mm; image-rendering: pixelated; }
  h1 { font-size: 27px; font-weight: 900; text-align: center; margin: 1mm 0 0; line-height: 1.2; letter-spacing: 0; }
  .sub { text-align: center; font-size: 19px; font-weight: 800; margin: 1mm 0 2mm; padding: 1mm 0; border-top: 3px solid #000; border-bottom: 3px solid #000; }
  hr { border: none; border-top: 2px dashed #000; margin: 2mm 0; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; padding: 1mm 0; font-size: 17px; }
  .row > :first-child { font-weight: 700; }
  .row > :last-child { font-weight: 900; text-align: left; }
  .row b { font-weight: 900; }
  table { width: 100%; border-collapse: collapse; font-size: 16px; }
  td, th { padding: 1.2mm 0.5mm; border-bottom: 2px solid #000; text-align: right; font-weight: 700; }
  th { font-weight: 900; font-size: 15px; border-bottom-width: 3px; }
  td.num, th.num { text-align: left; white-space: nowrap; font-weight: 900; }
  .total { white-space: nowrap; font-size: 23px; font-weight: 900; padding: 2mm 0; border-top: 3px solid #000; border-bottom: 3px solid #000; margin: 1mm 0; }
  .stamp { text-align: center; margin-top: 2mm; }
  .foot { text-align: center; font-size: 15px; font-weight: 700; margin-top: 2mm; line-height: 1.5; }
  [dir="ltr"] { font-family: Arial, sans-serif; }
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
    <div class="stamp">${stampSvg({ brand, mono: true, size: 170 })}</div>
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
    ${Number.isFinite(s.lat) ? `<div class="row"><span>الموقع</span><span dir="ltr" style="font-size:12px;word-break:break-all">${esc(`https://www.google.com/maps?q=${s.lat},${s.lng}`)}</span></div>` : ''}
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
    ${mapLink ? `<div class="row"><span>الموقع</span><span dir="ltr" style="font-size:12px;word-break:break-all">${esc(mapLink)}</span></div>` : ''}`}
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
  const c = mono ? '#000' : '#2840A7'; // كوبالت-800 — لون الختم
  const d = new Date(date).toLocaleDateString('en-GB', { timeZone: 'Asia/Amman' });
  // نصوص أفقية فقط: المتصفحات لا تشكّل الحروف العربية على مسار دائري (textPath) فتختفي حلقة الاسم
  const op = mono ? 1 : 0.9;
  const sw = mono ? [7, 3.5] : [5, 2.5];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200" style="transform:rotate(-8deg)">
  <g fill="none" stroke="${c}" opacity="${op}"><circle cx="100" cy="100" r="94" stroke-width="${sw[0]}"/><circle cx="100" cy="100" r="80" stroke-width="${sw[1]}"/>
    <line x1="34" y1="78" x2="166" y2="78" stroke-width="${sw[1]}"/><line x1="34" y1="134" x2="166" y2="134" stroke-width="${sw[1]}"/></g>
  <g fill="${c}" opacity="${op}" font-family="Arial,Tahoma" text-anchor="middle" font-weight="900">
    <text x="100" y="66" font-size="${mono ? 22 : 20}">${esc(brand)}</text>
    <text x="100" y="118" font-size="${mono ? 40 : 36}">معتمد</text>
    <text x="100" y="162" font-size="${mono ? 21 : 18}" font-weight="700">${esc(d)}</text>
  </g>
</svg>`;
}

/* الأوراق الرسمية (A4) بهوية PHI: جرافيت للنص، كوبالت للعناوين والمسطرة، نعناعي للفاصل،
   والقياسات من المقياس S(n) = 8 × φⁿ (بالبكسل عند الطباعة). الخط IBM Plex Sans Arabic مع بديل Tahoma. */
const PHI_PRINT = { graphite: '#111318', ink2: '#47494D', ink3: '#686A6E', line: '#D4D6D9', soft: '#F5F7FA', cobalt: '#365CFF', cobaltInk: '#2840A7', mint: '#31C6A5' };
const A4_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap');
  @page { size: A4; margin: 13mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif; color: ${PHI_PRINT.graphite}; direction: rtl; font-size: 13px; line-height: 1.618; font-variant-numeric: tabular-nums; }
  .head { display: flex; align-items: center; gap: 13px; border-bottom: 3px solid ${PHI_PRINT.cobalt}; padding-bottom: 8px; margin-bottom: 13px; }
  .head img { width: 55px; height: 55px; object-fit: contain; }
  .head h1 { margin: 0; font-size: 21px; line-height: 1.272; color: ${PHI_PRINT.graphite}; }
  .head .sub { color: ${PHI_PRINT.ink3}; font-size: 13px; }
  .title { font-size: 19px; font-weight: 700; text-align: center; margin: 5px 0 13px; color: ${PHI_PRINT.cobaltInk}; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 21px; margin-bottom: 13px; }
  .meta b { color: ${PHI_PRINT.ink2}; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid ${PHI_PRINT.line}; padding: 5px 8px; text-align: right; }
  th { background: ${PHI_PRINT.soft}; color: ${PHI_PRINT.ink2}; font-weight: 600; font-size: 11px; }
  td.num, th.num { text-align: left; white-space: nowrap; direction: ltr; }
  tfoot td { font-weight: 700; background: ${PHI_PRINT.soft}; }
  .sign { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 34px; }
  .sign .line { border-top: 1px solid ${PHI_PRINT.ink2}; width: 232px; text-align: center; padding-top: 3px; color: ${PHI_PRINT.ink2}; }
  .foot { margin-top: 21px; padding-top: 8px; border-top: 2px solid ${PHI_PRINT.mint}; font-size: 11px; color: ${PHI_PRINT.ink3}; text-align: center; }
`;

function a4Page(title, body, { brand = 'شركة البراق', logoUrl = colorLogoDataUri() } = {}) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>${A4_CSS}</style></head><body>
  <div class="head">${logoUrl ? `<img src="${esc(logoUrl)}" alt="">` : ''}<div><h1>${esc(brand)}</h1><div class="sub">للتوصيل — عمّان، الأردن</div></div></div>
  ${body}</body></html>`;
}

/**
 * ورقة «تسعيرة توصيل شركة البراق — خاصة بـ «المتجر»»: صفحة A4 واحدة دائماً (تُطبع أو تُحفظ PDF).
 * المناطق المحيطة بالمتجر مرتّبة بالمسافة، بالسعر بالقرش والدينار، مع الشعار والختم المعتمد.
 * أكثر من 16 منطقة ← عمودان، وأكثر من 40 ← خط أصغر — لتبقى صفحة واحدة.
 */
function priceSheetA4Html({ brand, storeName, storePhone, storeLocation, sheet, settings }) {
  const list = [...(sheet || [])].sort((a, b) => a.km - b.km);
  const n = list.length;
  const cols = n > 16 ? 2 : 1;
  const dense = n > 40;
  const jd = (f) => (Number(f || 0) / 100).toFixed(2);
  const per = Math.ceil(n / cols) || 1;
  const chunk = (i) => list.slice(i * per, (i + 1) * per);
  const table = (rows, offset) => `<table class="ps"><thead><tr><th class="c">#</th><th>المنطقة</th><th class="c">المسافة</th><th class="p">سعر التوصيل</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr><td class="c n">${offset + i + 1}</td><td class="a">${esc(r.areaName)}</td><td class="c">${km(r.km)}</td>
      <td class="p"><b>${Number(r.estimateFils || 0).toLocaleString('en-US')}</b> قرش<small>${jd(r.estimateFils)} د.أ</small></td></tr>`).join('')
  }</tbody></table>`;
  const tables = n ? Array.from({ length: cols }, (_, i) => table(chunk(i), i * per)).join('') : '<div class="empty">لا توجد مناطق مفعّلة بعد</div>';
  const date = new Date().toLocaleDateString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman', year: 'numeric', month: 'long', day: 'numeric' });
  const P = PHI_PRINT;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تسعيرة توصيل ${esc(brand)} — ${esc(storeName)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap');
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: 'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif; color: ${P.graphite}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: 210mm; height: 297mm; padding: 13mm 13mm 10mm; display: flex; flex-direction: column; overflow: hidden; position: relative; background: #fff; }
  .top { display: flex; align-items: center; gap: 8mm; padding-bottom: 5mm; border-bottom: 1.2mm solid ${P.cobalt}; }
  .top img { width: 40mm; height: 40mm; object-fit: contain; }
  .top .t1 { font-size: 13px; font-weight: 700; color: ${P.cobaltInk}; letter-spacing: 0; }
  .top h1 { margin: 1mm 0 0; font-size: 34px; line-height: 1.2; font-weight: 700; }
  .top .t3 { font-size: 15px; color: ${P.ink2}; margin-top: 1mm; }
  .for { margin: 6mm 0 4mm; display: flex; align-items: stretch; border: 0.5mm solid ${P.graphite}; border-radius: 2mm; overflow: hidden; }
  .for .k { background: ${P.graphite}; color: #fff; padding: 3mm 5mm; font-size: 15px; font-weight: 700; display: flex; align-items: center; }
  .for .v { padding: 2mm 5mm; flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .for .v b { font-size: 24px; line-height: 1.25; }
  .for .v span { font-size: 13px; color: ${P.ink3}; }
  .for .d { padding: 2mm 5mm; text-align: left; font-size: 13px; color: ${P.ink2}; display: flex; flex-direction: column; justify-content: center; border-inline-start: 0.3mm solid ${P.line}; }
  .rule { display: flex; gap: 3mm; align-items: center; background: ${P.soft}; border-inline-start: 1.2mm solid ${P.mint}; padding: 3mm 4mm; font-size: 14px; margin-bottom: 5mm; }
  .rule b { color: ${P.cobaltInk}; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 6mm; flex: 1; align-content: start; }
  table.ps { width: 100%; border-collapse: collapse; font-size: ${dense ? 12 : cols > 1 ? 14 : 16}px; }
  table.ps th { background: ${P.graphite}; color: #fff; font-weight: 700; font-size: ${dense ? 11 : 13}px; padding: ${dense ? 1.5 : 2.5}mm 3mm; text-align: right; }
  table.ps th.c, table.ps td.c { text-align: center; white-space: nowrap; }
  table.ps th.p, table.ps td.p { text-align: left; white-space: nowrap; }
  table.ps td { padding: ${dense ? 1.2 : cols > 1 ? 2 : 2.6}mm 3mm; border-bottom: 0.3mm solid ${P.line}; }
  table.ps tbody tr:nth-child(even) td { background: ${P.soft}; }
  table.ps td.n { color: ${P.ink3}; font-size: 0.85em; width: 9mm; }
  table.ps td.a { font-weight: 700; }
  table.ps td.p b { font-size: 1.3em; color: ${P.cobaltInk}; }
  table.ps td.p small { display: block; font-size: 0.72em; color: ${P.ink3}; }
  .empty { padding: 20mm; text-align: center; color: ${P.ink3}; font-size: 18px; border: 0.3mm dashed ${P.line}; }
  .bottom { margin-top: 5mm; display: grid; grid-template-columns: 1fr auto 1fr; gap: 6mm; align-items: end; }
  .note { font-size: 12px; line-height: 1.7; color: ${P.ink2}; }
  .sig { border-top: 0.3mm solid ${P.ink2}; padding-top: 1.5mm; text-align: center; font-size: 13px; color: ${P.ink2}; }
  .foot { margin-top: 4mm; padding-top: 2mm; border-top: 0.6mm solid ${P.mint}; display: flex; justify-content: space-between; font-size: 11px; color: ${P.ink3}; }
</style></head><body>
<div class="sheet" id="sheet">
  <div class="top">
    <img src="${colorLogoDataUri()}" alt="">
    <div>
      <div class="t1">للمناطق المحيطة بالمتجر</div>
      <h1>تسعيرة توصيل ${esc(brand)}</h1>
      <div class="t3">الأسعار محسوبة من موقع المتجر حتى مركز كل منطقة</div>
    </div>
  </div>
  <div class="for">
    <div class="k">خاصة بـ</div>
    <div class="v"><b>${esc(storeName)}</b><span dir="ltr" style="text-align:right">${esc(storePhone || '')}</span></div>
    <div class="d"><span>تاريخ الإصدار</span><b>${esc(date)}</b></div>
  </div>
  <div class="rule">التسعير: فتحة العداد <b>${fils(settings.meterFlagFils)}</b> + <b>${fils(settings.perKmFils)}</b> لكل كيلومتر هوائي · ${n} منطقة</div>
  <div class="grid">${tables}</div>
  <div class="bottom">
    <div class="note">السعر تقديري حتى مركز المنطقة. السعر النهائي يُحسب عند التسليم من موقع الزبون الفعلي.
      ${storeLocation ? `<br>موقع المتجر: <span dir="ltr">${storeLocation.lat.toFixed(5)}, ${storeLocation.lng.toFixed(5)}</span>` : ''}</div>
    <div>${stampSvg({ brand, size: 130 })}</div>
    <div class="sig">إدارة ${esc(brand)}</div>
  </div>
  <div class="foot"><span>وثيقة صادرة عن ${esc(brand)} للتوصيل</span><span>صالحة حتى تغيير موقع المتجر أو الأسعار</span></div>
</div>
</body></html>`;
}

/** تصريح سائق — A4 (يُقص كبطاقة) بالشعار والختم. */
function permitHtml({ brand, driver }) {
  const card = `
    <div style="border:2px solid ${PHI_PRINT.graphite};border-top:5px solid ${PHI_PRINT.cobalt};border-radius:8px;padding:21px;max-width:608px;margin:0 auto;position:relative">
      <div style="display:flex;align-items:center;gap:13px;border-bottom:2px solid ${PHI_PRINT.mint};padding-bottom:8px">
        <img src="${colorLogoDataUri()}" style="width:55px;height:55px;object-fit:contain" alt="">
        <div><div style="font-size:21px;font-weight:700;color:${PHI_PRINT.graphite}">${esc(brand)}</div><div style="color:${PHI_PRINT.ink3}">تصريح سائق توصيل</div></div>
        <div style="margin-inline-start:auto;text-align:left;direction:ltr;font-weight:700;font-size:16px;color:${PHI_PRINT.cobaltInk}">${esc(driver.permitNo)}</div>
      </div>
      <table style="margin-top:13px">
        <tr><th style="width:38%">الاسم</th><td style="font-size:16px;font-weight:700">${esc(driver.name)}</td></tr>
        <tr><th>الهاتف</th><td dir="ltr" style="text-align:right">${esc(driver.phone)}</td></tr>
        ${driver.nationalId ? `<tr><th>الرقم الوطني</th><td dir="ltr" style="text-align:right">${esc(driver.nationalId)}</td></tr>` : ''}
        <tr><th>المركبة</th><td>${esc(driver.vehicle || '—')}${driver.plate ? ` · لوحة <span dir="ltr">${esc(driver.plate)}</span>` : ''}</td></tr>
        <tr><th>تاريخ الإصدار</th><td>${esc(new Date(driver.permitIssuedAt).toLocaleDateString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman' }))}</td></tr>
        <tr><th>صالح حتى</th><td><b>${esc(new Date(driver.permitExpiresAt).toLocaleDateString('ar-JO-u-nu-latn', { timeZone: 'Asia/Amman' }))}</b></td></tr>
      </table>
      <p style="margin:8px 0 0">يُصرَّح لحامل هذا التصريح بالعمل سائقاً لدى ${esc(brand)} لتوصيل الطلبات من المتاجر المتعاقدة،
      ويُرجى من الجهات المعنية تسهيل مهمته. يُلغى التصريح بانتهاء مدته أو بإيقاف السائق.</p>
      <div class="sign" style="margin-top:13px"><div class="line">توقيع السائق</div><div>${stampSvg({ brand, size: 120 })}</div><div class="line">المدير المسؤول</div></div>
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
    <div class="stamp">${stampSvg({ brand, mono: true, size: 170 })}</div>
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
    <div class="stamp">${stampSvg({ brand, mono: true, size: 170 })}</div>`);
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
    <div class="row total"><span>المتبقي عليه</span><span>${fils(l.balanceFils)}</span></div>
    ${rows ? `<hr><table><thead><tr><th>المتجر</th><th class="num">كم</th><th class="num">للشركة</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <div class="stamp">${stampSvg({ brand, mono: true, size: 170 })}</div>`);
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
