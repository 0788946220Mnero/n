/*
  ═══════════════════════════════════════════════════════════════
  Apple Wallet — بطاقة ولاء (storeCard) بصيغة .pkpass، موقّعة بشهادة Pass Type ID من Apple.

  الملف: ZIP يحوي pass.json + الصور + manifest.json (SHA-1 لكل ملف) + signature
  (PKCS#7 منفصل على manifest.json، موقّع بمفتاح الشهادة، ومعه شهادة Apple WWDR الوسيطة).

  التحديث (Apple Wallet Passes Web Service):
    webServiceURL = {PUBLIC_API_URL}/api/loyalty/apple   — HTTPS إلزامي
    authenticationToken = HMAC(APPLE_PASS_AUTH_SECRET, serial) — لا يُخزَّن، يُشتق
    عند تغيّر الرصيد: إشعار APNs فارغ لكل جهاز مسجّل ← الآيفون يطلب أحدث نسخة.

  متغيرات البيئة (لا شيء منها في الكود ولا في الواجهة):
    APPLE_PASS_TYPE_ID, APPLE_TEAM_ID,
    APPLE_PASS_CERT_PEM_B64 + APPLE_PASS_KEY_PEM_B64 [+ APPLE_PASS_KEY_PASSPHRASE]
      أو APPLE_PASS_P12_B64 + APPLE_PASS_P12_PASSWORD,
    APPLE_WWDR_PEM_B64, APPLE_PASS_AUTH_SECRET, PUBLIC_API_URL
    اختياري: APPLE_APNS_HOST (افتراضي api.push.apple.com)
  ═══════════════════════════════════════════════════════════════
*/
const crypto = require('crypto');
const zlib = require('zlib');
const http2 = require('http2');
const forge = require('node-forge');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const AppleDeviceRegistration = require('../models/AppleDeviceRegistration');

const env = (k) => String(process.env[k] || '').trim();
const b64 = (k) => { const v = env(k); return v ? Buffer.from(v, 'base64').toString('utf8') : ''; };

/* ═════════ الإعداد ═════════ */

let credCache = null; let credKey = '';
/** الشهادة والمفتاح وشهادة WWDR من متغيرات البيئة — أو خطأ يشرح الناقص. */
function credentials() {
  const sig = ['APPLE_PASS_CERT_PEM_B64', 'APPLE_PASS_KEY_PEM_B64', 'APPLE_PASS_P12_B64', 'APPLE_WWDR_PEM_B64', 'APPLE_PASS_KEY_PASSPHRASE', 'APPLE_PASS_P12_PASSWORD']
    .map((k) => env(k).length + ':' + env(k).slice(-8)).join('|');
  if (credCache && credKey === sig) return credCache;
  let cert; let key;
  if (env('APPLE_PASS_P12_B64')) {
    const der = forge.util.decode64(env('APPLE_PASS_P12_B64'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), env('APPLE_PASS_P12_PASSWORD'));
    const certBag = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [])[0];
    const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]
      || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
    if (!certBag || !keyBag) throw new Error('ملف P12 لا يحوي الشهادة والمفتاح معاً');
    cert = certBag.cert; key = keyBag.key;
  } else {
    const certPem = b64('APPLE_PASS_CERT_PEM_B64');
    const keyPem = b64('APPLE_PASS_KEY_PEM_B64');
    if (!certPem || !keyPem) throw new Error('شهادة Pass Type ID غير مضبوطة');
    cert = forge.pki.certificateFromPem(certPem);
    key = env('APPLE_PASS_KEY_PASSPHRASE') ? forge.pki.decryptRsaPrivateKey(keyPem, env('APPLE_PASS_KEY_PASSPHRASE')) : forge.pki.privateKeyFromPem(keyPem);
    if (!key) throw new Error('تعذّر فك مفتاح الشهادة (كلمة المرور؟)');
  }
  const wwdrPem = b64('APPLE_WWDR_PEM_B64');
  if (!wwdrPem) throw new Error('شهادة Apple WWDR غير مضبوطة');
  const wwdr = forge.pki.certificateFromPem(wwdrPem);
  credCache = { cert, key, wwdr, certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(key) };
  credKey = sig;
  return credCache;
}

/** ما الناقص لتشغيل Apple Wallet؟ (للوحة الإدارة — بلا قيم أسرار) */
function missing() {
  const m = [];
  if (!env('APPLE_PASS_TYPE_ID')) m.push('APPLE_PASS_TYPE_ID');
  if (!env('APPLE_TEAM_ID')) m.push('APPLE_TEAM_ID');
  if (!env('APPLE_PASS_P12_B64') && !(env('APPLE_PASS_CERT_PEM_B64') && env('APPLE_PASS_KEY_PEM_B64'))) m.push('APPLE_PASS_P12_B64 أو APPLE_PASS_CERT_PEM_B64 + APPLE_PASS_KEY_PEM_B64');
  if (!env('APPLE_WWDR_PEM_B64')) m.push('APPLE_WWDR_PEM_B64');
  if (env('APPLE_PASS_AUTH_SECRET').length < 32) m.push('APPLE_PASS_AUTH_SECRET (32 حرفاً على الأقل)');
  if (!/^https:\/\//.test(env('PUBLIC_API_URL'))) m.push('PUBLIC_API_URL (https)');
  return m;
}
const isConfigured = () => missing().length === 0;

function status() {
  const m = missing();
  let certError = '';
  let expires = null;
  if (!m.length) {
    try { const c = credentials(); expires = c.cert.validity.notAfter; } catch (e) { certError = e.message; }
  }
  return { configured: !m.length && !certError, missing: m, certError, certExpires: expires, passTypeId: env('APPLE_PASS_TYPE_ID') };
}

const authToken = (serial) =>
  crypto.createHmac('sha256', env('APPLE_PASS_AUTH_SECRET')).update(`apple-pass:${serial}`).digest('base64url');
const tokenMatches = (serial, header) => {
  const m = /^ApplePass\s+(.+)$/.exec(String(header || ''));
  if (!m || !env('APPLE_PASS_AUTH_SECRET')) return false;
  const a = Buffer.from(authToken(serial)); const b = Buffer.from(m[1].trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/* ═════════ الصور (PNG مولّدة — بلا ملفات خارجية) ═════════ */

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const hexRgb = (hex) => { const h = String(hex || '#000000').replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); };

/** مربع ملوّن بدائرة ذهبية — أيقونة/شعار احتياطي حين لا يتوفر شعار المطعم بصيغة PNG. */
function solidPng(w, h, bgHex, dotHex) {
  const [r, g, b] = hexRgb(bgHex); const [dr, dg, db] = hexRgb(dotHex);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const cx = w / 2; const cy = h / 2; const rad = Math.min(w, h) * 0.32;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const inDot = (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2;
      raw[o] = inDot ? dr : r; raw[o + 1] = inDot ? dg : g; raw[o + 2] = inDot ? db : b; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const isPng = (buf) => buf && buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

/** شعار المطعم (PNG فقط) من رابطه — 3 ثوانٍ كحد أقصى، وإلا الاحتياطي. */
async function fetchPng(url) {
  if (!/^https:\/\//.test(String(url || ''))) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return isPng(buf) && buf.length < 400 * 1024 ? buf : null;
  } catch (_) { return null; }
}

/* ═════════ ZIP (deflate) ═════════ */

function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ═════════ التوقيع ═════════ */

/** PKCS#7 منفصل (DER) على manifest.json — بشهادة البطاقة، ومعه WWDR. */
function signManifest(manifestBuf, creds = credentials()) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuf.toString('binary'));
  p7.addCertificate(creds.cert);
  p7.addCertificate(creds.wwdr);
  p7.addSigner({
    key: creds.key,
    certificate: creds.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/* ═════════ البطاقة ═════════ */

const rgb = (hex) => { const [r, g, b] = hexRgb(hex); return `rgb(${r}, ${g}, ${b})`; };

/** pass.json لعضوية — بيانات حقيقية من القاعدة (الرصيد ورقم العضوية وQR). */
function passJson(acc, prog, ctx = {}) {
  const restaurant = ctx.restaurantName || 'ديار الأنباط';
  const next = (ctx.rewards || []).filter((r) => r.pointsCost > acc.balance).sort((a, b) => a.pointsCost - b.pointsCost)[0];
  const ready = (ctx.rewards || []).filter((r) => r.pointsCost <= acc.balance).sort((a, b) => b.pointsCost - a.pointsCost)[0];
  const base = `${env('PUBLIC_API_URL').replace(/\/+$/, '')}/api/loyalty/apple`;
  return {
    formatVersion: 1,
    passTypeIdentifier: env('APPLE_PASS_TYPE_ID'),
    teamIdentifier: env('APPLE_TEAM_ID'),
    serialNumber: acc.memberNo,
    organizationName: restaurant,
    description: prog.programName || `بطاقة ولاء ${restaurant}`,
    logoText: restaurant,
    foregroundColor: rgb(prog.colors && prog.colors.foreground),
    backgroundColor: rgb(prog.colors && prog.colors.background),
    labelColor: rgb(prog.colors && prog.colors.label),
    webServiceURL: base,
    authenticationToken: authToken(acc.memberNo),
    sharingProhibited: true,
    barcodes: [{ format: 'PKBarcodeFormatQR', message: acc.qrCode, messageEncoding: 'iso-8859-1', altText: acc.memberNo }],
    storeCard: {
      headerFields: [{ key: 'points', label: 'النقاط', value: acc.balance, changeMessage: 'رصيدك الآن %@ نقطة', textAlignment: 'PKTextAlignmentRight' }],
      primaryFields: [{ key: 'name', label: 'العضو', value: acc.name || 'عضو الولاء' }],
      secondaryFields: [
        { key: 'member', label: 'رقم العضوية', value: acc.memberNo },
        ready ? { key: 'ready', label: 'متاحة لك', value: ready.name } : { key: 'next', label: 'المكافأة القادمة', value: next ? `${next.name} — بعد ${next.pointsCost - acc.balance} نقطة` : '—' },
      ],
      backFields: [
        { key: 'earn', label: 'الاكتساب', value: `${prog.earnPerJod} نقطة لكل دينار على الطلبات المدفوعة` },
        { key: 'rewards', label: 'المكافآت', value: (ctx.rewards || []).map((r) => `${r.name}: ${r.pointsCost} نقطة`).join('\n') || '—' },
        { key: 'terms', label: 'الشروط', value: prog.terms || '' },
      ],
    },
  };
}

/** يبني ملف .pkpass موقّعاً. يرمي خطأً واضحاً إن لم تكتمل الإعدادات — لا بطاقات غير موقّعة أبداً. */
async function buildPass(acc, prog, ctx = {}) {
  const m = missing();
  if (m.length) throw Object.assign(new Error(`Apple Wallet غير مُعدّ: ${m.join('، ')}`), { status: 503 });
  const creds = credentials();
  const logo = await fetchPng(ctx.logoUrl);
  const bg = (prog.colors && prog.colors.background) || '#1f1a17';
  const dot = (prog.colors && prog.colors.label) || '#d4a017';
  const files = {
    'pass.json': Buffer.from(JSON.stringify(passJson(acc, prog, ctx)), 'utf8'),
    'icon.png': solidPng(29, 29, bg, dot),
    'icon@2x.png': solidPng(58, 58, bg, dot),
    'icon@3x.png': solidPng(87, 87, bg, dot),
    'logo.png': logo || solidPng(50, 50, bg, dot),
    'logo@2x.png': logo || solidPng(100, 100, bg, dot),
  };
  const manifest = {};
  for (const [n, d] of Object.entries(files)) manifest[n] = crypto.createHash('sha1').update(d).digest('hex');
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest), 'utf8');
  files.signature = signManifest(files['manifest.json'], creds);
  return zip(files);
}

/* ═════════ APNs: إشعار تحديث البطاقة ═════════ */

/** إشعار فارغ لكل جهاز مسجّل لهذه البطاقة. فشل جهاز لا يوقف البقية، والأخطاء تُسجَّل على العضوية. */
async function pushUpdate(accountId) {
  if (!isConfigured()) return { sent: 0, skipped: 'not-configured' };
  const acc = await LoyaltyAccount.findById(accountId).lean();
  if (!acc) return { sent: 0 };
  const regs = await AppleDeviceRegistration.find({ serialNumber: acc.memberNo, passTypeId: env('APPLE_PASS_TYPE_ID') }).lean();
  if (!regs.length) return { sent: 0 };
  const creds = credentials();
  const host = env('APPLE_APNS_HOST') || 'api.push.apple.com';
  let sent = 0; const errors = [];
  await new Promise((resolve) => {
    const client = http2.connect(`https://${host}`, {
      cert: creds.certPem, key: creds.keyPem,
      rejectUnauthorized: process.env.APPLE_APNS_INSECURE !== '1', // للاختبار المحلي فقط
    });
    client.on('error', (e) => { errors.push(e.message); resolve(); });
    let left = regs.length;
    const done = () => { if (--left === 0) { client.close(); resolve(); } };
    for (const r of regs) {
      const req = client.request({ ':method': 'POST', ':path': `/3/device/${r.pushToken}`, 'apns-topic': env('APPLE_PASS_TYPE_ID') });
      req.setTimeout(10000, () => { errors.push('timeout'); req.close(); });
      req.on('response', (h) => {
        const code = Number(h[':status']);
        if (code === 200) sent++;
        else {
          errors.push(`APNs ${code}`);
          // 410: الجهاز أزال البطاقة/التطبيق — نحذف تسجيله
          if (code === 410) AppleDeviceRegistration.deleteOne({ _id: r._id }).catch(() => {});
        }
      });
      req.on('error', (e) => errors.push(e.message));
      req.on('close', done);
      req.end('{}');
    }
  });
  await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: errors.length
    ? { 'apple.lastError': errors.join('، ').slice(0, 300), 'apple.lastErrorAt': new Date() }
    : { 'apple.lastPushAt': new Date(), 'apple.lastError': '' } });
  return { sent, errors };
}

/* ═════════ Web Service (تسجيل الأجهزة والتحديث) ═════════ */

async function register({ deviceLibraryId, passTypeId, serialNumber, pushToken }) {
  const acc = await LoyaltyAccount.findOne({ memberNo: serialNumber }).lean();
  if (!acc) return 404;
  const exists = await AppleDeviceRegistration.findOne({ deviceLibraryId, passTypeId, serialNumber });
  if (exists) {
    if (exists.pushToken !== pushToken) await AppleDeviceRegistration.updateOne({ _id: exists._id }, { $set: { pushToken } });
    return 200;
  }
  try { await AppleDeviceRegistration.create({ deviceLibraryId, passTypeId, serialNumber, pushToken, account: acc._id }); } catch (e) { if (e.code !== 11000) throw e; return 200; }
  await LoyaltyAccount.updateOne({ _id: acc._id }, { $inc: { 'apple.registeredDevices': 1 } });
  return 201;
}

async function unregister({ deviceLibraryId, passTypeId, serialNumber }) {
  const r = await AppleDeviceRegistration.deleteOne({ deviceLibraryId, passTypeId, serialNumber });
  if (r.deletedCount) {
    const acc = await LoyaltyAccount.findOne({ memberNo: serialNumber }).lean();
    if (acc) await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'apple.registeredDevices': Math.max(0, (acc.apple && acc.apple.registeredDevices || 1) - 1) } });
  }
  return 200;
}

/** أرقام البطاقات المسجّلة على الجهاز والتي تغيّرت بعد العلامة (tag = ميلي ثانية آخر تحديث). */
async function updatedSerials({ deviceLibraryId, passTypeId, since }) {
  const regs = await AppleDeviceRegistration.find({ deviceLibraryId, passTypeId }).lean();
  if (!regs.length) return null;
  const accs = await LoyaltyAccount.find({ memberNo: { $in: regs.map((r) => r.serialNumber) } }).lean();
  const t = Number(since) || 0;
  const changedAccs = accs.filter((a) => new Date(a.passUpdatedAt || 0).getTime() > t);
  if (!changedAccs.length) return { serialNumbers: [], lastUpdated: String(t || Date.now()) };
  const last = Math.max(...changedAccs.map((a) => new Date(a.passUpdatedAt).getTime()));
  return { serialNumbers: changedAccs.map((a) => a.memberNo), lastUpdated: String(last) };
}

module.exports = {
  isConfigured, missing, status, credentials, authToken, tokenMatches,
  passJson, buildPass, signManifest, zip, solidPng, crc32,
  pushUpdate, register, unregister, updatedSerials,
};
