/**
 * صور الزبائن (الصورة الشخصية وصور المحادثة) بلا مكتبة معالجة في الخادم:
 *  • النوع من «البصمة» داخل الملف نفسه — لا من الامتداد ولا من ترويسة المتصفح.
 *  • JPEG: تُزال كل مقاطع البيانات الوصفية (EXIF/GPS/XMP/التعليقات) قبل الحفظ،
 *    فلا يتسرّب موقع الزبون حتى لو رُفعت الصورة دون واجهتنا (الواجهة تعيد ترميزها أيضاً).
 *  • PNG/WebP مقبولة كما هي بعد التحقق من البصمة (الواجهة تحوّلها JPEG أصلاً).
 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** يزيل APP1..APP15 والتعليقات (COM) من JPEG ويُبقي APP0 (JFIF) وكل بيانات الصورة. */
function stripJpegMetadata(buf) {
  if (sniff(buf) !== 'image/jpeg') return buf;
  const out = [buf.slice(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf; // بنية غير متوقعة: نعيد الأصل بدل إفساده
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // حشو
    if (marker === 0xda) { out.push(buf.slice(i)); return Buffer.concat(out); } // بداية البيانات: الباقي كما هو
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.slice(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return buf;
    const isMeta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMeta) out.push(buf.slice(i, i + 2 + len));
    i += 2 + len;
  }
  return buf;
}

/** أبعاد الصورة (JPEG/PNG) إن أمكن — للعرض فقط. */
function dimensions(buf) {
  try {
    const t = sniff(buf);
    if (t === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (t === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (_) { /* */ }
  return null;
}

/** يتحقق من صورة مرفوعة ويُرجع { mime, data, width, height } أو { error }. */
function acceptImage(buf, maxBytes) {
  const mime = sniff(buf);
  if (!mime) return { error: 'الملف ليس صورة (JPG أو PNG أو WebP)' };
  if (buf.length > maxBytes) return { error: `الصورة أكبر من ${Math.round(maxBytes / 1024)}KB` };
  const data = mime === 'image/jpeg' ? stripJpegMetadata(buf) : buf;
  const d = dimensions(data) || {};
  return { mime, data, width: d.width || 0, height: d.height || 0 };
}

module.exports = { sniff, stripJpegMetadata, dimensions, acceptImage };
