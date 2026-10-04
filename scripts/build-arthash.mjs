#!/usr/bin/env node
/* ============================================================
   Art fingerprints for the card scanner — Deckhand 1.4
   ============================================================
   Runs weekly on GitHub Actions (.github/workflows/arthash.yml).
   For every paper printing in Scryfall's Default Cards it computes a
   64-bit perceptual hash of the card's art, from the small (146x204)
   image. The phone's scanner hashes the camera picture the same way and
   looks for the nearest one: that names the exact printing, and even a
   card whose name cannot be read (another language, a worn name bar).

     arthash.tsv.gz      "name<TAB>set<TAB>cn<TAB>hash16hex" per printing
     arthash-meta.json   when it was built, how many, how many still to do

   Incremental: hashes already in the previous file are kept (keyed by
   set + collector number), so a normal week only fetches the new set's
   images. The very first run has ~100k images to fetch; a budget per run
   (ARTHASH_BUDGET, default 40000) spreads that over a few runs -- each run
   publishes what it has, the next one carries on.

   The four hash functions below are a copy of ahGray32 / ahHash in
   index.html; tests/run-tests.js checks that both give the same bits.
   ============================================================ */
import { gunzipSync, createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bulkLines, requireDownloadUrl, isPaperPrint } from './build-bulk.mjs';

const OUT_DIR = process.env.OUT_DIR || '.';
const BUDGET = parseInt(process.env.ARTHASH_BUDGET || '40000', 10);
const PARALLEL = parseInt(process.env.ARTHASH_PARALLEL || '6', 10);
const INDEX_URL = process.env.ARTHASH_INDEX_URL || 'https://api.scryfall.com/bulk-data';
const UA = { headers: { 'User-Agent': 'Deckhand-arthash/1.0 (+https://deckhandcompanion.netlify.app)', 'Accept': '*/*' } };

/* ---- the hash (same as index.html) ---- */
export const AH_REGION = [0.12, 0.14, 0.88, 0.52];
export function ahGray32(px, w, h, reg){
  const X0 = reg[0] * w, Y0 = reg[1] * h, W = (reg[2] - reg[0]) * w, H = (reg[3] - reg[1]) * h;
  const out = new Float64Array(1024), cnt = new Float64Array(1024);
  const xs = Math.max(0, Math.floor(X0)), xe = Math.min(w, Math.ceil(X0 + W)), ys = Math.max(0, Math.floor(Y0)), ye = Math.min(h, Math.ceil(Y0 + H));
  for(let y = ys; y < ye; y++){
    const gy = Math.floor((y + 0.5 - Y0) / H * 32);
    if(gy < 0 || gy > 31) continue;
    for(let x = xs; x < xe; x++){
      const gx = Math.floor((x + 0.5 - X0) / W * 32);
      if(gx < 0 || gx > 31) continue;
      const i = (y * w + x) * 4, k = gy * 32 + gx;
      out[k] += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; cnt[k]++;
    }
  }
  for(let i = 0; i < 1024; i++) out[i] = cnt[i] ? out[i] / cnt[i] : 0;
  return out;
}
let _ahCos = null;
export function ahHash(g){
  if(!_ahCos){ _ahCos = new Float64Array(256); for(let u = 0; u < 8; u++) for(let x = 0; x < 32; x++) _ahCos[u * 32 + x] = Math.cos((2 * x + 1) * u * Math.PI / 64); }
  const tmp = new Float64Array(256), d = new Float64Array(64);
  for(let y = 0; y < 32; y++) for(let u = 0; u < 8; u++){ let s = 0; for(let x = 0; x < 32; x++) s += g[y * 32 + x] * _ahCos[u * 32 + x]; tmp[u * 32 + y] = s; }
  for(let v = 0; v < 8; v++) for(let u = 0; u < 8; u++){ let s = 0; for(let y = 0; y < 32; y++) s += tmp[u * 32 + y] * _ahCos[v * 32 + y]; d[v * 8 + u] = s; }
  const med = Array.from(d).slice(1).sort((a, b)=>a - b)[31];
  let hi = 0, lo = 0;
  for(let i = 0; i < 64; i++) if(d[i] > med){ if(i < 32) hi |= (1 << i); else lo |= (1 << (i - 32)); }
  return [hi >>> 0, lo >>> 0];
}
export function ahHex(h){ return h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0'); }

/* ---- which printings ---- */
export function smallImageOf(c){
  const iu = c.image_uris || (Array.isArray(c.card_faces) && c.card_faces[0] && c.card_faces[0].image_uris) || null;
  return iu && iu.small ? iu.small : null;
}
export function wantPrint(c){
  return isPaperPrint(c) && !!smallImageOf(c) && c.set && c.collector_number && c.name && c.image_status !== 'missing' && c.image_status !== 'placeholder';
}

async function decodeJpeg(buf){
  const jpeg = (await import('jpeg-js')).default;
  return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
}
export async function hashImage(buf){
  const img = await decodeJpeg(buf);
  return ahHex(ahHash(ahGray32(img.data, img.width, img.height, AH_REGION)));
}

async function readPrev(){
  const prev = new Map();
  try{
    const text = gunzipSync(await readFile(`${OUT_DIR}/arthash.tsv.gz`)).toString('utf-8');
    for(const line of text.split('\n')){
      const p = line.split('\t');
      if(p.length >= 4 && p[3].length === 16) prev.set(p[1] + '/' + p[2], p[3]);
    }
  }catch(e){}
  return prev;
}

async function writeGz(path, lines){
  const gz = createGzip({ level: 9 });
  const done = pipeline(gz, createWriteStream(path));
  for(const l of lines) if(!gz.write(l)) await new Promise(r=>gz.once('drain', r));
  gz.end();
  await done;
}

export async function build(fetchImpl){
  const f = fetchImpl || fetch;
  const r = await f(INDEX_URL, UA);
  if(!r.ok) throw new Error('bulk-data index: HTTP ' + r.status);
  const by = {};
  ((await r.json()).data || []).forEach(x=>{ by[x.type] = x; });
  const entry = by.default_cards || by['default-cards'];
  if(!entry) throw new Error('bulk-data index has no default_cards entry');
  const url = requireDownloadUrl(entry, 'Default Cards');
  console.log('Default Cards:', url);

  const prev = await readPrev();
  console.log(`${prev.size} hashes from the previous file.`);
  const rows = new Map();      // set/cn -> { name, set, cn, hash }
  const todo = [];
  for await (const c of bulkLines(url, f)){
    if(!wantPrint(c)) continue;
    const key = c.set + '/' + c.collector_number;
    if(rows.has(key)) continue;
    const row = { name: c.name, set: c.set, cn: c.collector_number, hash: prev.get(key) || null };
    rows.set(key, row);
    if(!row.hash) todo.push({ row, img: smallImageOf(c) });
  }
  console.log(`${rows.size} paper printings, ${todo.length} without a hash yet; this run does up to ${BUDGET}.`);

  const work = todo.slice(0, BUDGET);
  let next = 0, ok = 0, fail = 0;
  const worker = async ()=>{
    while(next < work.length){
      const t = work[next++];
      try{
        const res = await f(t.img, UA);
        if(!res.ok) throw new Error('HTTP ' + res.status);
        t.row.hash = await hashImage(Buffer.from(await res.arrayBuffer()));
        ok++;
      }catch(e){ fail++; }
      if((ok + fail) % 2000 === 0) console.log(`  …${ok + fail}/${work.length} (${fail} failed)`);
      await new Promise(r=>setTimeout(r, 40));      // polite to Scryfall's image servers
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, PARALLEL) }, worker));
  console.log(`Hashed ${ok}, failed ${fail}.`);

  const done = Array.from(rows.values()).filter(x=>x.hash);
  if(prev.size && done.length < prev.size * 0.8) throw new Error(`Only ${done.length} hashes against ${prev.size} last time — refusing to publish a thinner file.`);
  done.sort((a, b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : (a.set + a.cn < b.set + b.cn ? -1 : 1));
  await writeGz(`${OUT_DIR}/arthash.tsv.gz`, (function*(){ for(const x of done) yield `${x.name}\t${x.set}\t${x.cn}\t${x.hash}\n`; })());
  await writeFile(`${OUT_DIR}/arthash-meta.json`, JSON.stringify({
    format: 1, built: new Date().toISOString(), count: done.length, pending: rows.size - done.length,
    region: AH_REGION, sourceUpdatedAt: entry.updated_at || ''
  }, null, 2) + '\n');
  console.log(`arthash.tsv.gz: ${done.length} printings (${rows.size - done.length} still to do). Done.`);
  return { count: done.length, pending: rows.size - done.length };
}

const runDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if(runDirectly) build().catch(e=>{ console.error(e); process.exit(1); });
