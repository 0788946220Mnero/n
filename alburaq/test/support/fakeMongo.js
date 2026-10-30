/**
 * خادم MongoDB بديل داخل الذاكرة — للاختبار فقط.
 *
 * يتكلم بروتوكول MongoDB الحقيقي (OP_QUERY / OP_MSG)، فيعمل معه Mongoose وبرنامج التشغيل
 * الرسمي دون أي تعديل في كود التطبيق. يُستخدم حين لا يتوفر mongod في بيئة الاختبار.
 *
 * المحرك: mingo للاستعلامات والتجميع، مع تطبيق مستقل لعمليات التحديث يحاكي سلوك MongoDB:
 *   $set $unset $inc $push($each) $pull $addToSet $setOnInsert
 *   والمؤشرات الموضعية:  a.$.b  (يرفض إن لم يطابق الاستعلام عنصراً، تماماً كما يفعل MongoDB)
 *                         a.$[]  و  a.$[id]  مع arrayFilters
 *   والفهارس الفريدة (E11000) عند الإدراج.
 *
 * ليس بديلاً عن الاختبار على MongoDB حقيقية قبل النشر.
 */
const net = require('net');
const { BSON, ObjectId, Long } = require('mongoose').mongo; // برنامج تشغيل MongoDB المضمّن في Mongoose
require('mingo/init/system');
const { Query, Aggregator, find } = require('mingo');

const OID = '\u0001oid:';
const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

/* ───────── تحويل القيم: ObjectId ↔ نص قابل للمقارنة ───────── */

const isOid = (v) => v && typeof v === 'object' && (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID');
function norm(v) {
  if (v === null || v === undefined) return v;
  if (isOid(v)) return OID + v.toHexString();
  if (v instanceof Date || v instanceof RegExp) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') {
    if (v._bsontype === 'Long') return v.toNumber();
    if (v._bsontype === 'Int32' || v._bsontype === 'Double') return v.valueOf();
    // البيانات الثنائية تُحفظ كـ Uint8Array (تبقى سليمة مع structuredClone)
    if (v._bsontype === 'Binary') return new Uint8Array(v.buffer.subarray(0, v.position));
    const o = {};
    for (const k of Object.keys(v)) o[k] = norm(v[k]);
    return o;
  }
  if (typeof v === 'bigint') return Number(v);
  return v;
}
function denorm(v) {
  if (typeof v === 'string' && v.startsWith(OID)) return ObjectId.createFromHexString(v.slice(OID.length));
  if (v === null || v === undefined || v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return v.map(denorm);
  if (typeof v === 'object' && !v._bsontype) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = denorm(v[k]);
    return o;
  }
  return v;
}
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const stable = (v) => JSON.stringify(v, (k, x) => (x instanceof Date ? { $d: x.getTime() } : ArrayBuffer.isView(x) ? { $b: Buffer.from(x).toString('base64') } : x));
const deepEqual = (a, b) => stable(a) === stable(b);

/* ───────── أخطاء بشكل MongoDB ───────── */

class MongoErr extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ───────── المسارات والتحديثات ───────── */

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
const isOperatorObject = (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));

function getPath(doc, segs) {
  let cur = doc;
  for (const s of segs) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setPath(doc, segs, value) {
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] === undefined || cur[s] === null) cur[s] = {};
    cur = cur[s];
    if (typeof cur !== 'object') throw new MongoErr(28, `Cannot create field in element ${segs.slice(0, i + 1).join('.')}`);
  }
  cur[segs[segs.length - 1]] = value;
}

function unsetPath(doc, segs) {
  const parent = getPath(doc, segs.slice(0, -1));
  if (parent && typeof parent === 'object') {
    if (Array.isArray(parent)) parent[segs[segs.length - 1]] = null;
    else delete parent[segs[segs.length - 1]];
  }
}

/** شروط الاستعلام التي تخص حقل مصفوفة معيّن، كاستعلام على عنصر واحد منه. */
function elementCriteria(query, arrayPath) {
  const crit = {};
  let whole = null;
  const visit = (q) => {
    for (const [k, v] of Object.entries(q || {})) {
      if (k === '$and' && Array.isArray(v)) { v.forEach(visit); continue; }
      if (k === arrayPath) {
        if (isPlainObject(v) && v.$elemMatch) Object.assign(crit, v.$elemMatch);
        else whole = v;
      } else if (k.startsWith(arrayPath + '.')) {
        crit[k.slice(arrayPath.length + 1)] = v;
      }
    }
  };
  visit(query);
  return { crit, whole };
}

function positionalIndex(doc, query, arraySegs) {
  const arr = getPath(doc, arraySegs);
  const { crit, whole } = elementCriteria(query, arraySegs.join('.'));
  if (Array.isArray(arr) && (Object.keys(crit).length || whole !== null)) {
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      const okWhole = whole === null || (isOperatorObject(whole) ? new Query({ v: whole }).test({ v: el }) : deepEqual(el, whole));
      const okCrit = !Object.keys(crit).length || (isPlainObject(el) ? new Query(crit).test(el) : new Query({ v: crit }).test({ v: el }));
      if (okWhole && okCrit) return i;
    }
  }
  throw new MongoErr(2, 'The positional operator did not find the match needed from the query.');
}

function filterMatches(el, id, arrayFilters) {
  const spec = (arrayFilters || []).find((f) => Object.keys(f).some((k) => k === id || k.startsWith(id + '.')));
  if (!spec) throw new MongoErr(2, `No array filter found for identifier '${id}'`);
  const crit = {};
  let whole = null;
  for (const [k, v] of Object.entries(spec)) {
    if (k === id) whole = v;
    else crit[k.slice(id.length + 1)] = v;
  }
  if (whole !== null && !new Query({ v: whole }).test({ v: el })) return false;
  if (Object.keys(crit).length && !(isPlainObject(el) && new Query(crit).test(el))) return false;
  return true;
}

/** يحوّل مساراً فيه $ أو $[] أو $[id] إلى قائمة مسارات فعلية بأرقام العناصر. */
function expandPath(doc, path, query, arrayFilters) {
  const parts = path.split('.');
  let results = [[]];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const next = [];
    for (const prefix of results) {
      if (p === '$') {
        next.push([...prefix, positionalIndex(doc, query, prefix)]);
      } else if (p === '$[]' || /^\$\[[A-Za-z0-9_]+\]$/.test(p)) {
        const arr = getPath(doc, prefix);
        if (!Array.isArray(arr)) continue;
        const id = p === '$[]' ? null : p.slice(2, -1);
        arr.forEach((el, idx) => { if (id === null || filterMatches(el, id, arrayFilters)) next.push([...prefix, idx]); });
      } else {
        next.push([...prefix, p]);
      }
    }
    results = next;
  }
  return results;
}

function pullMatches(el, cond) {
  if (isOperatorObject(cond)) return new Query({ v: cond }).test({ v: el });
  if (isPlainObject(cond) && isPlainObject(el)) return new Query(cond).test(el);
  return deepEqual(el, cond);
}

function applyUpdate(doc, update, { query = {}, arrayFilters = [], isInsert = false } = {}) {
  const keys = Object.keys(update);
  if (!keys.length) return doc;
  if (!keys[0].startsWith('$')) {
    // استبدال كامل للوثيقة (مع الإبقاء على _id)
    return { _id: doc._id, ...clone(update) };
  }
  // كما في MongoDB: المسارات (و arrayFilters/$) تُحسب كلها على الوثيقة قبل أي تعديل
  const original = clone(doc);
  for (const op of keys) {
    const spec = update[op] || {};
    for (const [path, val] of Object.entries(spec)) {
      const targets = expandPath(original, path, query, arrayFilters);
      for (const segs of targets) {
        switch (op) {
          case '$set': setPath(doc, segs, clone(val)); break;
          case '$setOnInsert': if (isInsert) setPath(doc, segs, clone(val)); break;
          case '$unset': unsetPath(doc, segs); break;
          case '$inc': {
            const cur = getPath(doc, segs);
            if (cur !== undefined && cur !== null && typeof cur !== 'number') throw new MongoErr(14, 'Cannot apply $inc to a value of non-numeric type');
            setPath(doc, segs, (cur || 0) + val);
            break;
          }
          case '$push':
          case '$addToSet': {
            let arr = getPath(doc, segs);
            if (arr === undefined || arr === null) { arr = []; setPath(doc, segs, arr); }
            if (!Array.isArray(arr)) throw new MongoErr(2, `The field '${path}' must be an array`);
            const items = isPlainObject(val) && Array.isArray(val.$each) ? val.$each : [val];
            for (const it of items) {
              if (op === '$addToSet' && arr.some((x) => deepEqual(x, it))) continue;
              arr.push(clone(it));
            }
            if (op === '$push' && isPlainObject(val) && typeof val.$slice === 'number') {
              const s = val.$slice;
              const kept = s < 0 ? arr.slice(s) : arr.slice(0, s);
              arr.length = 0; arr.push(...kept);
            }
            break;
          }
          case '$pull': {
            const arr = getPath(doc, segs);
            if (!Array.isArray(arr)) break;
            const kept = arr.filter((el) => !pullMatches(el, val));
            arr.length = 0; arr.push(...kept);
            break;
          }
          case '$min': { const cur = getPath(doc, segs); if (cur === undefined || val < cur) setPath(doc, segs, clone(val)); break; }
          case '$max': { const cur = getPath(doc, segs); if (cur === undefined || val > cur) setPath(doc, segs, clone(val)); break; }
          case '$currentDate': setPath(doc, segs, new Date()); break;
          default: throw new MongoErr(9, `Unknown modifier: ${op}`);
        }
      }
    }
  }
  return doc;
}

/** الحقول المتساوية في الاستعلام تُنسخ للوثيقة الجديدة عند upsert. */
function seedFromQuery(query) {
  const doc = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (k.startsWith('$')) continue;
    if (isOperatorObject(v)) { if ('$eq' in v) setPath(doc, k.split('.'), clone(v.$eq)); continue; }
    setPath(doc, k.split('.'), clone(v));
  }
  return doc;
}

/* ───────── التخزين ───────── */

class Store {
  constructor() { this.colls = new Map(); }
  coll(name) {
    if (!this.colls.has(name)) this.colls.set(name, { docs: [], indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }] });
    return this.colls.get(name);
  }
  reset() { this.colls.clear(); }
  checkUnique(coll, doc, exceptIdx = -1) {
    for (const ix of coll.indexes) {
      if (!ix.unique) continue;
      const keys = Object.keys(ix.key);
      if (ix.partialFilterExpression && !new Query(ix.partialFilterExpression).test(doc)) continue;
      const val = keys.map((k) => getPath(doc, k.split('.')));
      if (val.every((v) => v === undefined) && ix.sparse) continue;
      coll.docs.forEach((other, i) => {
        if (i === exceptIdx) return;
        if (ix.partialFilterExpression && !new Query(ix.partialFilterExpression).test(other)) return;
        const ov = keys.map((k) => getPath(other, k.split('.')));
        if (deepEqual(ov, val)) throw new MongoErr(11000, `E11000 duplicate key error index: ${ix.name} dup key: ${stable(val)}`);
      });
    }
  }
}

/* ───────── الأوامر ───────── */

function cursorReply(ns, docs) {
  return { cursor: { id: Long.ZERO, ns, firstBatch: docs.map(denorm) }, ok: 1 };
}

function project(doc, projection) {
  if (!projection || !Object.keys(projection).length) return doc;
  return find([doc], {}, projection).all()[0];
}

function selectDocs(coll, filter, { sort, skip, limit } = {}) {
  let cur = find(coll.docs, filter || {});
  if (sort && Object.keys(sort).length) cur = cur.sort(sort);
  if (skip) cur = cur.skip(skip);
  if (limit) cur = cur.limit(Math.abs(limit));
  return cur.all();
}

function handle(store, body, seqs) {
  const cmd = Object.keys(body)[0];
  const lc = cmd.toLowerCase();
  const dbName = body.$db || 'test';
  const collName = typeof body[cmd] === 'string' ? body[cmd] : null;
  const ns = `${dbName}.${collName}`;

  switch (lc) {
    case 'hello':
    case 'ismaster':
      return {
        helloOk: true, ismaster: true, isWritablePrimary: true,
        maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000,
        localTime: new Date(), logicalSessionTimeoutMinutes: 30, connectionId: 1,
        minWireVersion: 0, maxWireVersion: 21, readOnly: false, ok: 1,
      };
    case 'ping': case 'endsessions': case 'killcursors': case 'getlasterror':
      return { ok: 1 };
    case 'buildinfo':
      return { version: '7.0.0-fake', versionArray: [7, 0, 0, 0], ok: 1 };
    case 'create':
      store.coll(collName);
      return { ok: 1 };
    case 'createindexes': {
      const c = store.coll(collName);
      for (const ix of body.indexes || []) {
        if (!c.indexes.some((x) => x.name === ix.name)) c.indexes.push(norm(ix));
      }
      return { ok: 1, createdCollectionAutomatically: false, numIndexesBefore: 1, numIndexesAfter: c.indexes.length };
    }
    case 'listindexes':
      return cursorReply(ns, store.coll(collName).indexes.map((i) => ({ v: 2, ...i })));
    case 'listcollections':
      return cursorReply(`${dbName}.$cmd.listCollections`, [...store.colls.keys()].map((name) => ({ name, type: 'collection', options: {}, info: { readOnly: false } })));
    case 'drop':
      store.colls.delete(collName);
      return { ok: 1 };
    case 'dropdatabase':
      store.reset();
      return { ok: 1 };
    case 'find': {
      const c = store.coll(collName);
      const filter = norm(body.filter || {});
      let docs = selectDocs(c, filter, { sort: body.sort, skip: body.skip, limit: body.limit });
      docs = docs.map((d) => project(clone(d), norm(body.projection)));
      return cursorReply(ns, docs);
    }
    case 'getmore':
      return { cursor: { id: Long.ZERO, ns: `${dbName}.${body.collection}`, nextBatch: [] }, ok: 1 };
    case 'count': {
      const c = store.coll(collName);
      return { n: selectDocs(c, norm(body.query || {})).length, ok: 1 };
    }
    case 'distinct': {
      const c = store.coll(collName);
      const vals = [];
      for (const d of selectDocs(c, norm(body.query || {}))) {
        const v = getPath(d, body.key.split('.'));
        if (v !== undefined && !vals.some((x) => deepEqual(x, v))) vals.push(v);
      }
      return { values: denorm(vals), ok: 1 };
    }
    case 'insert': {
      const c = store.coll(collName);
      const docs = body.documents || (seqs && seqs.documents) || [];
      const writeErrors = [];
      let n = 0;
      docs.forEach((raw, index) => {
        const d = norm(raw);
        if (d._id === undefined) d._id = OID + new ObjectId().toHexString();
        try {
          store.checkUnique(c, d);
          c.docs.push(d);
          n++;
        } catch (e) {
          writeErrors.push({ index, code: e.code || 2, errmsg: e.message });
          if (body.ordered !== false) return;
        }
      });
      return writeErrors.length ? { n, writeErrors, ok: 1 } : { n, ok: 1 };
    }
    case 'update': {
      const c = store.coll(collName);
      const ups = body.updates || (seqs && seqs.updates) || [];
      let n = 0, nModified = 0;
      const upserted = [];
      const writeErrors = [];
      ups.forEach((u, index) => {
        try {
          const q = norm(u.q || {});
          const upd = norm(u.u);
          const af = norm(u.arrayFilters || []);
          const matched = selectDocs(c, q);
          const targets = u.multi ? matched : matched.slice(0, 1);
          if (!targets.length && u.upsert) {
            let doc = seedFromQuery(q);
            doc = applyUpdate(doc, upd, { query: q, arrayFilters: af, isInsert: true });
            if (doc._id === undefined) doc._id = OID + new ObjectId().toHexString();
            store.checkUnique(c, doc);
            c.docs.push(doc);
            n++;
            upserted.push({ index, _id: denorm(doc._id) });
            return;
          }
          for (const t of targets) {
            const idx = c.docs.indexOf(t);
            const before = stable(t);
            const updated = applyUpdate(clone(t), upd, { query: q, arrayFilters: af });
            store.checkUnique(c, updated, idx);
            n++;
            if (stable(updated) !== before) { c.docs[idx] = updated; nModified++; }
          }
        } catch (e) {
          writeErrors.push({ index, code: e.code || 2, errmsg: e.message });
        }
      });
      const res = { n, nModified, ok: 1 };
      if (upserted.length) res.upserted = upserted;
      if (writeErrors.length) res.writeErrors = writeErrors;
      return res;
    }
    case 'delete': {
      const c = store.coll(collName);
      let n = 0;
      for (const d of body.deletes || (seqs && seqs.deletes) || []) {
        const matched = selectDocs(c, norm(d.q || {}));
        const targets = d.limit === 1 ? matched.slice(0, 1) : matched;
        for (const t of targets) { c.docs.splice(c.docs.indexOf(t), 1); n++; }
      }
      return { n, ok: 1 };
    }
    case 'findandmodify': {
      const c = store.coll(collName);
      const q = norm(body.query || {});
      const matched = selectDocs(c, q, { sort: body.sort, limit: 1 });
      const fields = norm(body.fields);
      const target = matched[0];
      if (body.remove) {
        if (target) c.docs.splice(c.docs.indexOf(target), 1);
        return { lastErrorObject: { n: target ? 1 : 0 }, value: target ? denorm(project(clone(target), fields)) : null, ok: 1 };
      }
      const upd = norm(body.update);
      const af = norm(body.arrayFilters || []);
      if (!target) {
        if (!body.upsert) return { lastErrorObject: { n: 0, updatedExisting: false }, value: null, ok: 1 };
        let doc = seedFromQuery(q);
        doc = applyUpdate(doc, upd, { query: q, arrayFilters: af, isInsert: true });
        if (doc._id === undefined) doc._id = OID + new ObjectId().toHexString();
        store.checkUnique(c, doc);
        c.docs.push(doc);
        return { lastErrorObject: { n: 1, updatedExisting: false, upserted: denorm(doc._id) }, value: body.new ? denorm(project(clone(doc), fields)) : null, ok: 1 };
      }
      const idx = c.docs.indexOf(target);
      const before = clone(target);
      const updated = applyUpdate(clone(target), upd, { query: q, arrayFilters: af });
      store.checkUnique(c, updated, idx);
      c.docs[idx] = updated;
      return { lastErrorObject: { n: 1, updatedExisting: true }, value: denorm(project(clone(body.new ? updated : before), fields)), ok: 1 };
    }
    case 'aggregate': {
      const c = store.coll(collName);
      const pipeline = norm(body.pipeline || []);
      const out = new Aggregator(pipeline, { collectionResolver: (name) => store.coll(name).docs }).run(c.docs.map(clone));
      return cursorReply(ns, out);
    }
    default:
      return { ok: 0, errmsg: `no such command: '${cmd}'`, code: 59, codeName: 'CommandNotFound' };
  }
}

function safeHandle(store, body, seqs) {
  try {
    return handle(store, body, seqs);
  } catch (e) {
    return { ok: 0, errmsg: e.message, code: e.code || 1, codeName: e.code === 11000 ? 'DuplicateKey' : 'BadValue' };
  }
}

/* ───────── البروتوكول ───────── */

function readCString(buf, offset) {
  const end = buf.indexOf(0, offset);
  return { str: buf.toString('utf8', offset, end), next: end + 1 };
}

function reply(socket, responseTo, opCode, payloadParts) {
  const payload = Buffer.concat(payloadParts);
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + payload.length, 0);
  header.writeInt32LE(Math.floor(Math.random() * 1e9), 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(opCode, 12);
  socket.write(Buffer.concat([header, payload]));
}

function onMessage(store, socket, msg) {
  const requestID = msg.readInt32LE(4);
  const opCode = msg.readInt32LE(12);
  if (opCode === OP_QUERY) {
    let off = 20; // header + flags
    const { next } = readCString(msg, off);
    off = next + 8; // numberToSkip + numberToReturn
    const docLen = msg.readInt32LE(off);
    const query = BSON.deserialize(msg.subarray(off, off + docLen), { promoteLongs: true });
    const body = query.$query || query;
    const res = BSON.serialize(safeHandle(store, body));
    const head = Buffer.alloc(20);
    head.writeInt32LE(0, 0);                    // responseFlags
    head.writeBigInt64LE(0n, 4);                // cursorID
    head.writeInt32LE(0, 12);                   // startingFrom
    head.writeInt32LE(1, 16);                   // numberReturned
    reply(socket, requestID, OP_REPLY, [head, res]);
    return;
  }
  if (opCode === OP_MSG) {
    const flags = msg.readUInt32LE(16);
    const end = flags & 1 ? msg.length - 4 : msg.length;
    let off = 20;
    let body = null;
    const seqs = {};
    while (off < end) {
      const kind = msg.readUInt8(off); off += 1;
      if (kind === 0) {
        const len = msg.readInt32LE(off);
        body = BSON.deserialize(msg.subarray(off, off + len), { promoteLongs: true });
        off += len;
      } else {
        const size = msg.readInt32LE(off);
        const stop = off + size;
        const { str, next } = readCString(msg, off + 4);
        let p = next;
        seqs[str] = [];
        while (p < stop) {
          const len = msg.readInt32LE(p);
          seqs[str].push(BSON.deserialize(msg.subarray(p, p + len), { promoteLongs: true }));
          p += len;
        }
        off = stop;
      }
    }
    const res = BSON.serialize(safeHandle(store, body, seqs));
    const moreToCome = flags & 2;
    if (moreToCome) return; // كتابة بلا رد
    reply(socket, requestID, OP_MSG, [Buffer.from([0, 0, 0, 0]), Buffer.from([0]), res]);
  }
}

/** يشغّل الخادم على منفذ عشوائي ويعيد { uri, store, close }. */
function startFakeMongo() {
  const store = new Store();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < len) break;
        const msg = buf.subarray(0, len);
        buf = buf.subarray(len);
        try { onMessage(store, socket, msg); } catch (e) { console.error('fakeMongo:', e); }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        uri: `mongodb://127.0.0.1:${port}/delivery_test`,
        store,
        close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startFakeMongo, applyUpdate, expandPath, norm, denorm };

// تشغيل مستقل: node test/support/fakeMongo.js  ← يطبع الرابط ويبقى يعمل
if (require.main === module) {
  startFakeMongo().then(({ uri }) => console.log(uri));
}
