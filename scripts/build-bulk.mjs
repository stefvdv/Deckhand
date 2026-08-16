#!/usr/bin/env node
/* ============================================================
   Weekly Scryfall bulk trimmer — Admirals & Commanders MTG
   ============================================================
   Runs on GitHub Actions (see .github/workflows/bulk-data.yml).
   Downloads the official Oracle Cards and Rulings bulk files,
   keeps only the fields the app uses, and writes three files
   into the repo root (deployed by Netlify next to index.html):

     oracle-slim.jsonl.gz    one trimmed card per line
     rulings-slim.jsonl.gz   one {o, r:[{d,c}]} line per oracle_id
     bulk-meta.json          tiny manifest the app can poll cheaply

   The phone never touches the raw 148 MB — all trimming happens
   on GitHub's machines, and Scryfall sees ONE download a week.

   Field legend for oracle-slim lines (absent = empty/false):
     n  name                id  scryfall id (drives image URLs)
     o  oracle_id           mc  mana_cost        mv cmc
     tl type_line           ot  oracle_text
     c  colors "WU"         ci  color_identity "WUB"
     kw keywords []         pm  produced_mana "WUBRGC"
     pw power               tg  toughness        ly layout
     st set code            cn  collector_number
     sn set_name            r   rarity
     lg legalities.commander ('legal' | 'banned' | 'not_legal' | 'restricted')
     eur cheapest of prices.eur / eur_foil   eurf prices.eur_foil
     rk edhrec_rank         gc  1 when game_changer
     f  card_faces, each {name, mc, tl, ot, c, pw, tg}
   ============================================================ */
import { createGunzip, createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';

const UA = { headers: { 'User-Agent': 'AdmiralsAndCommanders-bulk/1.0 (admirals-and-commanders.netlify.app)', 'Accept': '*/*' } };
const OUT_DIR = process.env.OUT_DIR || '.';

/* ---- the official index tells us today's download URLs ---- */
export async function bulkIndex(fetchImpl){
  const f = fetchImpl || fetch;
  const r = await f('https://api.scryfall.com/bulk-data', UA);
  if(!r.ok) throw new Error('bulk-data index: HTTP ' + r.status);
  const d = await r.json();
  const by = {};
  (d.data || []).forEach(x => { by[x.type] = x; });
  if(!by.oracle_cards || !by.rulings) throw new Error('bulk-data index is missing oracle_cards or rulings');
  return by;
}

/* ---- stream any bulk download as one JSON object per yield ----
   Handles every shape Scryfall has served: a pretty-printed JSON
   array (one object per line with trailing commas), plain JSONL,
   raw bytes, Content-Encoding gzip (auto-undone by fetch), or a
   .gz payload (detected by magic bytes and gunzipped here). */
export async function* bulkLines(url, fetchImpl){
  const f = fetchImpl || fetch;
  const r = await f(url, UA);
  if(!r.ok || !r.body) throw new Error('bulk download: HTTP ' + r.status + ' for ' + url);
  let stream = Readable.fromWeb(r.body);
  const first = await new Promise((resolve, reject)=>{
    const onReadable = ()=>{ const b = stream.read(2); if(b !== null){ cleanup(); resolve(b); } };
    const onEnd = ()=>{ cleanup(); resolve(null); };
    const onErr = (e)=>{ cleanup(); reject(e); };
    const cleanup = ()=>{ stream.off('readable', onReadable); stream.off('end', onEnd); stream.off('error', onErr); };
    stream.on('readable', onReadable); stream.once('end', onEnd); stream.once('error', onErr);
  });
  if(first === null) return;
  stream.unshift(first);
  if(first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b){
    const gz = createGunzip();
    stream.on('error', e=>gz.destroy(e));
    stream = stream.pipe(gz);
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl){
    let line = raw.trim();
    if(!line || line === '[' || line === ']') continue;
    if(line.endsWith(',')) line = line.slice(0, -1);
    if(line.startsWith('[')){
      // compact array on one line — parse it whole and yield each element
      // (defensive path; a naive text split would shatter nested card_faces)
      const arr = JSON.parse(line);
      for(const el of arr) if(el && typeof el === 'object') yield el;
      continue;
    }
    if(!line.startsWith('{')) continue;
    yield JSON.parse(line);
  }
}

/* ---- trimming ---- */
const SKIP_LAYOUTS = new Set(['art_series', 'token', 'double_faced_token', 'emblem']);

export function trimFace(fc){
  const o = { name: fc.name };
  if(fc.mana_cost) o.mc = fc.mana_cost;
  if(fc.type_line) o.tl = fc.type_line;
  if(fc.oracle_text) o.ot = fc.oracle_text;
  if(fc.colors && fc.colors.length) o.c = fc.colors.join('');
  if(fc.power != null) o.pw = fc.power;
  if(fc.toughness != null) o.tg = fc.toughness;
  return o;
}

export function trimCard(c){
  if(!c || !c.name || !c.id) return null;
  if(c.digital) return null;                       // never selectable in the app
  if(SKIP_LAYOUTS.has(c.layout)) return null;
  const eur  = c.prices && c.prices.eur  != null ? Number(c.prices.eur)      : null;
  const eurf = c.prices && c.prices.eur_foil != null ? Number(c.prices.eur_foil) : null;
  const cheapest = (eur != null && eurf != null) ? Math.min(eur, eurf) : (eur != null ? eur : eurf);
  const o = { n: c.name, id: c.id, o: c.oracle_id };
  if(c.mana_cost) o.mc = c.mana_cost;
  o.mv = c.cmc || 0;
  o.tl = c.type_line || '';
  if(c.oracle_text) o.ot = c.oracle_text;
  if(c.colors && c.colors.length) o.c = c.colors.join('');
  if(c.color_identity && c.color_identity.length) o.ci = c.color_identity.join('');
  if(c.keywords && c.keywords.length) o.kw = c.keywords;
  if(c.produced_mana && c.produced_mana.length) o.pm = c.produced_mana.join('');
  if(c.power != null) o.pw = c.power;
  if(c.toughness != null) o.tg = c.toughness;
  if(c.layout) o.ly = c.layout;
  if(c.set) o.st = c.set;
  if(c.collector_number) o.cn = c.collector_number;
  if(c.set_name) o.sn = c.set_name;
  if(c.rarity) o.r = c.rarity;
  if(c.legalities && c.legalities.commander) o.lg = c.legalities.commander;
  if(cheapest != null && !Number.isNaN(cheapest)) o.eur = cheapest;
  if(eurf != null && !Number.isNaN(eurf)) o
