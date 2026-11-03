/**
 * قاعدة MongoDB في الذاكرة لاختبار نماذج Mongoose الحقيقية بلا خادم Mongo:
 * يستبدل دوال النموذج (create/find/findOne/findOneAndUpdate/updateOne/...) بتنفيذ في الذاكرة،
 * مع تحقق Mongoose الحقيقي (validateSync والقيم الافتراضية) وفرض الفهارس الفريدة (E11000)
 * وعوامل الاستعلام والتحديث المستخدمة في المشروع ($in $ne $gte $or $regex | $set $inc $push $pull $setOnInsert).
 * لا يدعم aggregate — الكود المختبَر لا يستعمله.
 */
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

function clone(v) {
  if (v instanceof ObjectId) return new ObjectId(String(v));
  if (v instanceof Date) return new Date(v.getTime());
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (v instanceof RegExp) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}
const norm = (v) => (v instanceof ObjectId ? String(v) : v instanceof Date ? v.getTime() : v && v._bsontype === 'ObjectId' ? String(v) : v);

function getPath(obj, path) {
  const parts = path.split('.');
  let cur = [obj];
  for (const p of parts) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      const v = c[p];
      if (Array.isArray(v) && parts[parts.length - 1] !== p) next.push(...v); else next.push(v);
    }
    cur = next;
  }
  return cur.length <= 1 ? cur[0] : cur;
}

const eqVal = (a, b) => {
  if (b instanceof RegExp) return typeof a === 'string' && b.test(a);
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => eqVal(x, b));
  return norm(a) === norm(b) || (a == null && b == null);
};

function matchCond(val, cond) {
  if (cond instanceof RegExp || cond instanceof ObjectId || cond instanceof Date || cond === null || typeof cond !== 'object' || Array.isArray(cond)) return eqVal(val, cond);
  const keys = Object.keys(cond);
  if (!keys.some((k) => k.startsWith('$'))) return JSON.stringify(clone(val)) === JSON.stringify(clone(cond));
  return keys.every((op) => {
    const c = cond[op];
    switch (op) {
      case '$in': return c.some((x) => eqVal(val, x));
      case '$nin': return !c.some((x) => eqVal(val, x));
      case '$ne': return !eqVal(val, c);
      case '$eq': return eqVal(val, c);
      case '$gt': return val != null && norm(val) > norm(c);
      case '$gte': return val != null && norm(val) >= norm(c);
      case '$lt': return val != null && norm(val) < norm(c);
      case '$lte': return val != null && norm(val) <= norm(c);
      case '$exists': return (val !== undefined) === !!c;
      case '$regex': return typeof val === 'string' && new RegExp(c, cond.$options || '').test(val);
      case '$options': return true;
      default: throw new Error(`memoryDb: عامل غير مدعوم ${op}`);
    }
  });
}

function matches(doc, filter = {}) {
  return Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    if (k === '$nor') return !cond.some((f) => matches(doc, f));
    return matchCond(getPath(doc, k), cond);
  });
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  while (parts.length > 1) { const p = parts.shift(); if (o[p] == null || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
  o[parts[0]] = value;
}
function unsetPath(obj, path) {
  const parts = path.split('.');
  let o = obj;
  while (parts.length > 1) { o = o[parts.shift()]; if (o == null) return; }
  delete o[parts[0]];
}

function applyUpdate(doc, update, inserting) {
  const ops = Object.keys(update || {});
  if (ops.length && !ops[0].startsWith('$')) { for (const [k, v] of Object.entries(update)) setPath(doc, k, clone(v)); return; }
  for (const [op, fields] of Object.entries(update)) {
    for (const [k, v] of Object.entries(fields || {})) {
      if (op === '$set') setPath(doc, k, clone(v));
      else if (op === '$setOnInsert') { if (inserting) setPath(doc, k, clone(v)); }
      else if (op === '$unset') unsetPath(doc, k);
      else if (op === '$inc') setPath(doc, k, (Number(getPath(doc, k)) || 0) + Number(v));
      else if (op === '$push') { const arr = getPath(doc, k) || []; arr.push(...(v && v.$each ? clone(v.$each) : [clone(v)])); setPath(doc, k, arr); }
      else if (op === '$addToSet') { const arr = getPath(doc, k) || []; if (!arr.some((x) => eqVal(x, v))) arr.push(clone(v)); setPath(doc, k, arr); }
      else if (op === '$pull') { const arr = getPath(doc, k) || []; setPath(doc, k, arr.filter((x) => !(typeof v === 'object' && !(v instanceof ObjectId) ? matches(x, v) : eqVal(x, v)))); }
      else throw new Error(`memoryDb: تحديث غير مدعوم ${op}`);
    }
  }
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const spec = typeof sort === 'string'
    ? sort.split(/\s+/).filter(Boolean).map((s) => (s.startsWith('-') ? [s.slice(1), -1] : [s, 1]))
    : Object.entries(sort);
  return docs.slice().sort((a, b) => {
    for (const [k, dir] of spec) {
      const x = norm(getPath(a, k)); const y = norm(getPath(b, k));
      if (x === y) continue;
      if (x == null) return -dir; if (y == null) return dir;
      return (x > y ? 1 : -1) * (Number(dir) >= 0 ? 1 : -1);
    }
    return 0;
  });
}

class Q {
  constructor(exec) { this._exec = exec; this.o = { lean: false, sort: null, skip: 0, limit: 0, plus: [] }; }
  lean() { this.o.lean = true; return this; }
  // كما في Mongoose: حقول select:false لا تُعاد إلا بـ .select('+field')
  select(spec) { if (typeof spec === 'string') spec.split(/\s+/).forEach((x) => { if (x.startsWith('+')) this.o.plus.push(x.slice(1)); }); return this; }
  populate() { return this; }
  session() { return this; }
  sort(s) { this.o.sort = s; return this; }
  skip(n) { this.o.skip = n; return this; }
  limit(n) { this.o.limit = n; return this; }
  exec() { return this.then(); }
  then(res, rej) { return Promise.resolve().then(() => this._exec(this.o)).then(res, rej); }
  catch(f) { return this.then(null, f); }
}

function install(Model) {
  const store = new Map();
  const uniques = [];
  for (const [fields, opts] of Model.schema.indexes()) if (opts && opts.unique) uniques.push(Object.keys(fields));
  Model.schema.eachPath((p, t) => { if (t.options && t.options.unique && !uniques.some((u) => u.length === 1 && u[0] === p)) uniques.push([p]); });

  const hidden = []; Model.schema.eachPath((p, t) => { if (t.options && t.options.select === false) hidden.push(p); });
  const strip = (doc, plus = []) => { if (doc) hidden.forEach((p) => { if (!plus.includes(p)) delete doc[p]; }); return doc; };
  const out = (doc, lean, plus) => (doc == null ? null : lean ? strip(clone(doc), plus) : Model.hydrate(strip(clone(doc), plus)));
  const checkUnique = (doc, selfId) => {
    for (const fields of uniques) {
      const key = fields.map((f) => JSON.stringify(norm(getPath(doc, f))));
      if (fields.every((f) => getPath(doc, f) == null)) continue;
      for (const [id, other] of store) {
        if (id === selfId) continue;
        if (fields.every((f, i) => JSON.stringify(norm(getPath(other, f))) === key[i])) {
          throw Object.assign(new Error(`E11000 duplicate key error collection: ${Model.collection.name} index: ${fields.join('_')}`), { code: 11000 });
        }
      }
    }
  };
  const insert = (raw) => {
    const d = new Model(raw);
    const err = d.validateSync();
    if (err) throw err;
    const obj = d.toObject({ depopulate: true });
    if (Model.schema.options.timestamps) {
      const now = new Date();
      if (Model.schema.options.timestamps === true || Model.schema.options.timestamps.createdAt !== false) obj.createdAt = obj.createdAt || now;
      if (Model.schema.options.timestamps === true || Model.schema.options.timestamps.updatedAt !== false) obj.updatedAt = obj.updatedAt || now;
    }
    checkUnique(obj, null);
    store.set(String(obj._id), clone(obj));
    return obj;
  };
  const all = (filter) => [...store.values()].filter((d) => matches(d, filter));
  const touch = (doc) => { if (Model.schema.options.timestamps === true || (Model.schema.options.timestamps && Model.schema.options.timestamps.updatedAt !== false)) doc.updatedAt = new Date(); };

  Model.create = async (input, opts) => {
    const many = Array.isArray(input);
    const docs = (many ? input : [input]).map((x) => Model.hydrate(clone(insert(x instanceof mongoose.Model ? x.toObject() : x))));
    void opts;
    return many ? docs : docs[0];
  };
  Model.insertMany = async (arr) => Model.create(arr);
  Model.find = (filter = {}) => new Q((o) => {
    let r = sortDocs(all(filter), o.sort);
    if (o.skip) r = r.slice(o.skip);
    if (o.limit) r = r.slice(0, o.limit);
    return r.map((d) => out(d, o.lean, o.plus));
  });
  Model.findOne = (filter = {}) => new Q((o) => out(sortDocs(all(filter), o.sort)[0], o.lean, o.plus));
  Model.findById = (id) => Model.findOne({ _id: id });
  Model.exists = async (filter) => { const d = all(filter)[0]; return d ? { _id: d._id } : null; };
  Model.countDocuments = (filter = {}) => new Q(() => all(filter).length);
  Model.estimatedDocumentCount = async () => store.size;

  const upsertBase = (filter) => {
    const base = {};
    for (const [k, v] of Object.entries(filter || {})) {
      if (k.startsWith('$')) continue;
      if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date) && Object.keys(v).some((x) => x.startsWith('$'))) continue;
      setPath(base, k, clone(v));
    }
    return base;
  };
  const updateDoc = (doc, update) => {
    const next = clone(doc);
    applyUpdate(next, update, false);
    touch(next);
    const d = new Model(next);
    const casted = d.toObject({ depopulate: true });
    checkUnique(casted, String(doc._id));
    store.set(String(doc._id), clone(casted));
    return casted;
  };
  Model.findOneAndUpdate = (filter, update, opts = {}) => new Q((o) => {
    const doc = sortDocs(all(filter), opts.sort)[0];
    if (!doc) {
      if (!opts.upsert) return null;
      const base = upsertBase(filter);
      applyUpdate(base, update, true);
      const created = insert(base);
      return opts.new || opts.returnDocument === 'after' ? out(created, o.lean, o.plus) : null;
    }
    const before = clone(doc);
    const after = updateDoc(doc, update);
    return out(opts.new || opts.returnDocument === 'after' ? after : before, o.lean, o.plus);
  });
  Model.findByIdAndUpdate = (id, update, opts) => Model.findOneAndUpdate({ _id: id }, update, opts);
  Model.updateOne = (filter, update, opts = {}) => new Q(() => {
    const doc = all(filter)[0];
    if (!doc) {
      if (opts.upsert) { const base = upsertBase(filter); applyUpdate(base, update, true); insert(base); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    updateDoc(doc, update);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  Model.updateMany = (filter, update) => new Q(() => { const ds = all(filter); ds.forEach((d) => updateDoc(d, update)); return { matchedCount: ds.length, modifiedCount: ds.length }; });
  Model.deleteOne = (filter) => new Q(() => { const d = all(filter)[0]; if (d) store.delete(String(d._id)); return { deletedCount: d ? 1 : 0 }; });
  Model.deleteMany = (filter = {}) => new Q(() => { const ds = all(filter); ds.forEach((d) => store.delete(String(d._id))); return { deletedCount: ds.length }; });
  Model.aggregate = () => { throw new Error('memoryDb: aggregate غير مدعوم'); };
  Model.prototype.save = async function save() {
    const obj = this.toObject({ depopulate: true });
    if (store.has(String(obj._id))) { touch(obj); checkUnique(obj, String(obj._id)); store.set(String(obj._id), clone(obj)); }
    else insert(obj);
    return this;
  };
  Model.__store = store;
  return store;
}

/** يثبّت الذاكرة على كل النماذج المسجّلة في mongoose (بعد require لها). */
function installAll() {
  const stores = {};
  for (const name of mongoose.modelNames()) stores[name] = install(mongoose.model(name));
  return {
    stores,
    reset() { Object.values(stores).forEach((s) => s.clear()); },
    all(name) { return [...stores[name].values()].map(clone); },
  };
}

module.exports = { install, installAll, matches };
