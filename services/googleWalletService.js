/*
  ═══════════════════════════════════════════════════════════════
  Google Wallet — Loyalty Class واحد للبرنامج + Loyalty Object لكل زبون (Google Wallet REST API).

  «أضف إلى Google Wallet»: رابط https://pay.google.com/gp/v/save/{JWT} موقّع RS256 بمفتاح
  حساب الخدمة (Service Account) — على الخادم فقط، ولا يصل المفتاح للواجهة أبداً.
    1) نحاول إنشاء الصنف والبطاقة عبر الـ API أولاً (JWT صغير يحوي المعرّف فقط)
    2) إن تعذّر الـ API: JWT يحوي البطاقة كاملة (Google ينشئها عند الحفظ)
  التحديث: PATCH للبطاقة عند تغيّر الرصيد (في الخلفية — لا يؤخر الكاشير).

  متغيرات البيئة:
    GOOGLE_WALLET_ISSUER_ID
    GOOGLE_WALLET_SA_JSON_B64  (ملف JSON لحساب الخدمة، base64)
      أو GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_PRIVATE_KEY_B64
    اختياري: GOOGLE_WALLET_CLASS_SUFFIX (افتراضي diyar_loyalty)، GOOGLE_WALLET_ORIGINS (نطاقات الموقع)
  ═══════════════════════════════════════════════════════════════
*/
const jwt = require('jsonwebtoken');
const LoyaltyAccount = require('../models/LoyaltyAccount');

const env = (k) => String(process.env[k] || '').trim();
const API = () => env('GOOGLE_WALLET_API') || 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = () => env('GOOGLE_WALLET_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

function serviceAccount() {
  if (env('GOOGLE_WALLET_SA_JSON_B64')) {
    try {
      const j = JSON.parse(Buffer.from(env('GOOGLE_WALLET_SA_JSON_B64'), 'base64').toString('utf8'));
      return { email: j.client_email, key: j.private_key };
    } catch (_) { return { email: '', key: '', error: 'GOOGLE_WALLET_SA_JSON_B64 ليس JSON صالحاً' }; }
  }
  const key = env('GOOGLE_WALLET_SA_PRIVATE_KEY_B64') ? Buffer.from(env('GOOGLE_WALLET_SA_PRIVATE_KEY_B64'), 'base64').toString('utf8') : '';
  return { email: env('GOOGLE_WALLET_SA_EMAIL'), key };
}

function missing() {
  const m = [];
  if (!/^\d{5,}$/.test(env('GOOGLE_WALLET_ISSUER_ID'))) m.push('GOOGLE_WALLET_ISSUER_ID');
  const sa = serviceAccount();
  if (sa.error) m.push(sa.error);
  else if (!sa.email || !/BEGIN (RSA )?PRIVATE KEY/.test(sa.key)) m.push('GOOGLE_WALLET_SA_JSON_B64 (أو GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_PRIVATE_KEY_B64)');
  return m;
}
const isConfigured = () => missing().length === 0;
const issuer = () => env('GOOGLE_WALLET_ISSUER_ID');
const classId = () => `${issuer()}.${(env('GOOGLE_WALLET_CLASS_SUFFIX') || 'diyar_loyalty').replace(/[^\w.-]/g, '_')}`;
const objectIdFor = (acc) => `${issuer()}.${String(acc.memberNo).replace(/[^\w.-]/g, '_')}`;

let lastError = ''; let lastErrorAt = null; let lastOkAt = null;
const status = () => ({ configured: isConfigured(), missing: missing(), issuerId: issuer(), classId: issuer() ? classId() : '', lastError, lastErrorAt, lastOkAt });

/* ═════════ OAuth (حساب الخدمة) ═════════ */

let token = null; let tokenExp = 0;
async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({ iss: sa.email, scope: SCOPE, aud: TOKEN_URL(), iat: now, exp: now + 3600 }, sa.key, { algorithm: 'RS256' });
  const r = await fetch(TOKEN_URL(), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google OAuth ${r.status}: ${(j.error_description || j.error || '').toString().slice(0, 120)}`);
  token = j.access_token; tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return token;
}

async function api(method, path, body) {
  const r = await fetch(`${API()}${path}`, {
    method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw Object.assign(new Error(`Google Wallet ${r.status}: ${((j.error && j.error.message) || '').slice(0, 160)}`), { status: r.status });
  return j;
}

/* ═════════ الصنف والبطاقة ═════════ */

function classBody(prog, ctx = {}) {
  const restaurant = ctx.restaurantName || 'ديار الأنباط';
  const logo = ctx.logoUrl || prog.logoUrl;
  return {
    id: classId(),
    issuerName: restaurant,
    programName: prog.programName || `نقاط ${restaurant}`,
    ...(/^https:\/\//.test(String(logo || '')) ? { programLogo: { sourceUri: { uri: logo }, contentDescription: { defaultValue: { language: 'ar', value: restaurant } } } } : {}),
    hexBackgroundColor: (prog.colors && prog.colors.background) || '#1f1a17',
    reviewStatus: 'UNDER_REVIEW',
    localizedIssuerName: { defaultValue: { language: 'ar', value: restaurant } },
    countryCode: 'JO',
  };
}

function objectBody(acc) {
  return {
    id: objectIdFor(acc),
    classId: classId(),
    state: acc.status === 'blocked' ? 'INACTIVE' : 'ACTIVE',
    accountId: acc.memberNo,
    accountName: acc.name || 'عضو الولاء',
    loyaltyPoints: { label: 'النقاط', balance: { int: Math.trunc(acc.balance || 0) } },
    barcode: { type: 'QR_CODE', value: acc.qrCode, alternateText: acc.memberNo },
  };
}

async function ensureClass(prog, ctx) {
  const body = classBody(prog, ctx);
  if (!body.programLogo) throw new Error('Google Wallet يتطلب شعار المطعم برابط https (من الإعدادات أو برنامج الولاء)');
  const got = await api('GET', `/loyaltyClass/${encodeURIComponent(classId())}`);
  if (got.notFound) return api('POST', '/loyaltyClass', body);
  return got;
}

async function upsertObject(acc) {
  const body = objectBody(acc);
  const got = await api('GET', `/loyaltyObject/${encodeURIComponent(body.id)}`);
  if (got.notFound) return api('POST', '/loyaltyObject', body);
  return api('PATCH', `/loyaltyObject/${encodeURIComponent(body.id)}`, { state: body.state, accountName: body.accountName, loyaltyPoints: body.loyaltyPoints, barcode: body.barcode });
}

const note = (err) => {
  if (err) { lastError = String(err.message || err).slice(0, 300); lastErrorAt = new Date(); } else { lastOkAt = new Date(); lastError = ''; }
};

/**
 * رابط «أضف إلى Google Wallet» لعضوية. يرجع { url, mode: 'api'|'jwt' }.
 * الـ API أولاً؛ إن فشل (شبكة/صلاحيات) نضع البطاقة كاملة داخل JWT فيُنشئها Google عند الحفظ.
 */
async function saveUrl(acc, prog, ctx = {}) {
  const m = missing();
  if (m.length) throw Object.assign(new Error(`Google Wallet غير مُعدّ: ${m.join('، ')}`), { status: 503 });
  const sa = serviceAccount();
  let payload; let mode = 'api';
  try {
    await ensureClass(prog, ctx);
    await upsertObject(acc);
    payload = { loyaltyObjects: [{ id: objectIdFor(acc), classId: classId() }] };
    note(null);
  } catch (e) {
    note(e);
    mode = 'jwt';
    const cls = classBody(prog, ctx);
    payload = { loyaltyObjects: [objectBody(acc)], ...(cls.programLogo ? { loyaltyClasses: [cls] } : {}) };
  }
  const origins = env('GOOGLE_WALLET_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  const signed = jwt.sign({ iss: sa.email, aud: 'google', typ: 'savetowallet', origins, payload }, sa.key, { algorithm: 'RS256' });
  await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'google.objectId': objectIdFor(acc), 'google.savedAt': acc.google && acc.google.savedAt ? acc.google.savedAt : new Date() } });
  return { url: `https://pay.google.com/gp/v/save/${signed}`, mode, objectId: objectIdFor(acc) };
}

/** هل حفظها الزبون فعلاً؟ (hasUsers من Google — آلية موثوقة لمعرفة حالة البطاقة) */
async function hasUsers(acc) {
  if (!isConfigured() || !acc.google || !acc.google.objectId) return null;
  try {
    const o = await api('GET', `/loyaltyObject/${encodeURIComponent(acc.google.objectId)}`);
    return o.notFound ? false : !!o.hasUsers;
  } catch (_) { return null; }
}

/** تحديث الرصيد على البطاقة بعد تغيّره — يُسجَّل الخطأ على العضوية ولا يُرمى. */
async function syncAccount(accountId) {
  if (!isConfigured()) return { skipped: 'not-configured' };
  const acc = await LoyaltyAccount.findById(accountId).lean();
  if (!acc || !acc.google || !acc.google.objectId) return { skipped: 'not-issued' };
  try {
    const body = objectBody(acc);
    const r = await api('PATCH', `/loyaltyObject/${encodeURIComponent(acc.google.objectId)}`, { state: body.state, loyaltyPoints: body.loyaltyPoints, accountName: body.accountName });
    if (r.notFound) throw new Error('البطاقة غير موجودة لدى Google (لم تُحفظ بعد)');
    await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'google.lastSyncAt': new Date(), 'google.lastError': '' } });
    note(null);
    return { ok: true };
  } catch (e) {
    note(e);
    await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'google.lastError': String(e.message).slice(0, 300), 'google.lastErrorAt': new Date() } });
    return { ok: false, error: e.message };
  }
}

/** تحديث الصنف (الاسم/الألوان/الشعار) بعد تعديل البرنامج. */
async function syncClass(prog, ctx) {
  if (!isConfigured()) return { skipped: 'not-configured' };
  try {
    const got = await api('GET', `/loyaltyClass/${encodeURIComponent(classId())}`);
    const body = classBody(prog, ctx);
    if (got.notFound) { if (body.programLogo) await api('POST', '/loyaltyClass', body); }
    else await api('PATCH', `/loyaltyClass/${encodeURIComponent(classId())}`, { programName: body.programName, hexBackgroundColor: body.hexBackgroundColor, ...(body.programLogo ? { programLogo: body.programLogo } : {}) });
    note(null);
    return { ok: true };
  } catch (e) { note(e); return { ok: false, error: e.message }; }
}

const _resetForTests = () => { token = null; tokenExp = 0; lastError = ''; lastErrorAt = null; lastOkAt = null; };

module.exports = { isConfigured, missing, status, classId, objectIdFor, classBody, objectBody, saveUrl, hasUsers, syncAccount, syncClass, accessToken, _resetForTests };
