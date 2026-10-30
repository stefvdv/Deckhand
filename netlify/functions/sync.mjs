/* Deckhand sync (1.26): one shared document per link code, in Netlify Blobs.
   No accounts and no keys to set up: the link code IS the key. Only its
   SHA-256 hash is ever used as the storage name, so the store never holds
   a code that would let someone in.

   The document: { rev, keys: { <name>: { t, r, v } | { t, r, del:1 } } }
     t = when the device changed that piece (its own clock), the newest wins
     r = the document revision in which the piece last changed here

   Two calls, both POST JSON:
     { op:'probe', code }                         -> { rev }   (a few bytes)
     { op:'sync', code, since, changes, after }   -> { rev, changes, more }
       changes in : what this device changed since it last sent
       changes out: every piece with r > since that the device did not just
                    send, at most ~3.5 MB per answer; `more` is the cursor
                    for the next page (send it back as `after`).

   Testable: handle(body, { store }) with a fake store. */
import crypto from 'node:crypto';

const STORE = 'deckhand-sync';
const PAGE = 3_500_000;          // characters per answer page
const MAX_DOC = 60_000_000;      // a whole account, generously
const MAX_KEY = 160;

export function idOf(code){
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if(c.length < 16 || c.length > 40) return null;
  return crypto.createHash('sha256').update('deckhand-sync:' + c).digest('hex');
}

async function readDoc(store, id){
  let doc = null, etag = null;
  try{
    if(typeof store.getWithMetadata === 'function'){
      const r = await store.getWithMetadata(id, { type: 'json' });
      if(r){ doc = r.data; etag = r.etag || null; }
    } else {
      doc = await store.get(id, { type: 'json' });
    }
  }catch(e){ doc = null; }
  if(!doc || typeof doc !== 'object' || !doc.keys) doc = { rev: 0, keys: {} };
  return { doc, etag };
}

async function writeDoc(store, id, doc, etag){
  const opts = { metadata: { rev: doc.rev } };
  if(etag) opts.onlyIfMatch = etag;
  else opts.onlyIfNew = true;
  let res;
  try{ res = await store.setJSON(id, doc, opts); }
  catch(e){
    // An older blobs library without conditional writes: plain write.
    res = await store.setJSON(id, doc, { metadata: { rev: doc.rev } });
  }
  // Newer libraries answer { modified:false } when someone wrote first.
  return !(res && res.modified === false);
}

export async function handle(body, ctx){
  const store = ctx && ctx.store;
  if(!store) return { status: 503, json: { ok: false, error: 'store' } };
  const id = idOf(body && body.code);
  if(!id) return { status: 400, json: { ok: false, error: 'code' } };
  const op = body.op;

  if(op === 'probe'){
    try{
      if(typeof store.getMetadata === 'function'){
        const m = await store.getMetadata(id);
        if(m && m.metadata && m.metadata.rev != null) return { status: 200, json: { ok: true, rev: +m.metadata.rev || 0 } };
        if(!m) return { status: 200, json: { ok: true, rev: 0 } };
      }
    }catch(e){}
    const { doc } = await readDoc(store, id);
    return { status: 200, json: { ok: true, rev: doc.rev || 0 } };
  }

  if(op !== 'sync') return { status: 400, json: { ok: false, error: 'op' } };
  const since = Math.max(0, +body.since || 0);
  const incoming = (body.changes && typeof body.changes === 'object') ? body.changes : {};

  let doc, applied;
  for(let attempt = 0; attempt < 5; attempt++){
    const got = await readDoc(store, id);
    doc = got.doc;
    applied = new Set();
    const newRev = (doc.rev || 0) + 1;
    for(const k of Object.keys(incoming)){
      if(typeof k !== 'string' || !k || k.length > MAX_KEY) continue;
      const c = incoming[k];
      if(!c || typeof c.t !== 'number' || !isFinite(c.t)) continue;
      const cur = doc.keys[k];
      if(cur && !(c.t > cur.t)) continue;           // the newest change wins
      if(c.del) doc.keys[k] = { t: c.t, r: newRev, del: 1 };
      else if(typeof c.v === 'string') doc.keys[k] = { t: c.t, r: newRev, v: c.v };
      else continue;
      applied.add(k);
    }
    if(!applied.size) break;
    doc.rev = newRev;
    if(JSON.stringify(doc).length > MAX_DOC) return { status: 413, json: { ok: false, error: 'size' } };
    if(await writeDoc(store, id, doc, got.etag)) break;
    if(attempt === 4) return { status: 409, json: { ok: false, error: 'busy' } };
  }

  // Everything newer than what the device has seen, page by page.
  const after = body.after && typeof body.after === 'object' ? body.after : null;
  const list = Object.keys(doc.keys)
    .filter(k=>doc.keys[k].r > since && !applied.has(k))
    .sort((a, b)=>(doc.keys[a].r - doc.keys[b].r) || (a < b ? -1 : a > b ? 1 : 0));
  const out = {};
  let size = 0, more = null, started = !after;
  for(const k of list){
    const e = doc.keys[k];
    if(!started){
      if(e.r > after.r || (e.r === after.r && k > after.k)) started = true;
      else continue;
    }
    const piece = e.del ? { t: e.t, del: 1 } : { t: e.t, v: e.v };
    const len = (e.v ? e.v.length : 0) + k.length + 40;
    if(size && size + len > PAGE){ more = true; break; }
    out[k] = piece; size += len;
  }
  if(more){
    // the cursor names the LAST piece sent
    const lastK = Object.keys(out).pop();
    more = { r: doc.keys[lastK].r, k: lastK };
  }
  return { status: 200, json: { ok: true, rev: doc.rev || 0, changes: out, more } };
}

export default async (req) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
  if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if(req.method !== 'POST') return new Response('POST', { status: 405, headers: cors });
  let body = {};
  try{ body = await req.json(); }catch(e){ return Response.json({ ok: false, error: 'json' }, { status: 400, headers: cors }); }
  let store = null;
  try{ const { getStore } = await import('@netlify/blobs'); store = getStore({ name: STORE, consistency: 'strong' }); }catch(e){ store = null; }
  let r;
  try{ r = await handle(body, { store }); }
  catch(e){ r = { status: 500, json: { ok: false, error: 'server', detail: String(e && e.message || e).slice(0, 200) } }; }
  return Response.json(r.json, { status: r.status, headers: { ...cors, 'cache-control': 'no-store' } });
};
