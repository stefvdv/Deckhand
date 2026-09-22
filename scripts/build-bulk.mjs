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

   Run with --prices (or BULK_MODE=prices) and it does something much
   smaller instead: it streams the Default Cards bulk file, which holds
   EVERY printing, and writes the cheapest paper euro price per card name:

     prices-slim.tsv.gz      "name<TAB>eur" per line, ~300 KB
     prices-meta.json        when it was built, and how many names

   That mode runs daily. It is the same arithmetic the app does when it
   asks Scryfall itself — cheapest prices.eur across non-digital prints —
   so a deck total is right without a single request from the phone.

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
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

const UA = { headers: { 'User-Agent': 'Deckhand-bulk/1.1 (+https://deckhandcompanion.netlify.app)', 'Accept': '*/*' } };
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
  // Oracle Tags is optional — Scryfall added it recently and may rename it.
  by._tags = by.oracle_tags || by['oracle-tags'] || by.otags || null;
  return by;
}

/* ---- find the download link, whatever Scryfall calls it today ----
   The index schema has drifted before (the JSONL migration). Try every
   plausible shape; if none fits, dump the whole entry into the log so
   the failing run documents the real schema for the next fix. */
export function downloadUrlOf(item){
  if(!item) return null;
  if(typeof item.jsonl_download_uri === 'string') return item.jsonl_download_uri;
  if(typeof item.download_uri === 'string') return item.download_uri;
  if(typeof item.download_url === 'string') return item.download_url;
  if(item.download_uris && typeof item.download_uris === 'object'){
    const vals = Object.values(item.download_uris).filter(v=>typeof v === 'string');
    const jsonl = vals.find(v=>v.includes('jsonl'));
    if(jsonl) return jsonl;
    if(vals.length) return vals[0];
  }
  if(Array.isArray(item.files)){
    for(const fl of item.files){
      if(!fl) continue;
      if(typeof fl.download_uri === 'string') return fl.download_uri;
      if(typeof fl.url === 'string') return fl.url;
      if(typeof fl.uri === 'string' && /^https?:/.test(fl.uri)) return fl.uri;
    }
  }
  return null;
}
export function requireDownloadUrl(item, label){
  const u = downloadUrlOf(item);
  if(u) return u;
  console.error(`Could not find a download link on the ${label} bulk entry.`);
  console.error('Here is the full entry Scryfall sent — this tells us their new schema:');
  console.error(JSON.stringify(item, null, 2));
  throw new Error(`No download link found for ${label} — see the entry dump above.`);
}

/* ---- stream any bulk download as one JSON object per yield ----
   Handles every shape Scryfall has served: a pretty-printed JSON
   array (one object per line with trailing commas), plain JSONL,
   raw bytes, Content-Encoding gzip (auto-undone by fetch), or a
   .gz payload (detected by magic bytes and gunzipped here). A
   compact single-line array is split on "},{" as a last resort. */
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
  if(eurf != null && !Number.isNaN(eurf)) o.eurf = eurf;
  if(c.edhrec_rank) o.rk = c.edhrec_rank;
  if(c.game_changer) o.gc = 1;
  if(c.card_faces && c.card_faces.length) o.f = c.card_faces.map(trimFace);
  return o;
}

/* Only the tags the app actually consults — everything else is trimmed. */
export const APP_TAGS = new Set(['removal','creature-removal','artifact-removal','enchantment-removal','planeswalker-removal','spot-removal','boardwipe','edict','bounce','tuck','bite','burn','counterspell','threaten','sacrifice-outlet','stifle','ramp','mana-rock','mana-dork','ritual','land-ramp','mana-doubler','mana-sink','untapper','lands-matter','cheat-into-play','draw','cantrip','card-advantage','wheel','impulse','rummage','tutor','peek','draw-engine','mill','self-mill','discard','reanimate','recursion','regrowth','graveyard-hate','token-doubler','anthem','overrun','counters-matter','counter-doubler','protection','fog','prevent-damage','lifegain','tax','hatebear','silence','rule-of-law','pillowfort','damage-doubler','extra-combat','extra-attack','evasion','unblockable','lure','attack-trigger','combat-trick','blink','flicker','clone','copy-spell','copy-permanent','copy-trigger','death-trigger','cast-trigger','group-hug','group-slug','voting','donate','extra-turn','removal-exile','removal-fight','removal-sacrifice','removal-toughness','removal-land','removal-permanent','mass-land-denial','mass-shrink','theft','theft-permanent','repeatable-token-generator','repeatable-creature-tokens','repeatable-artifact-tokens','repeatable-treasures','repeatable-clues','repeatable-food','repeatable-blood','repeatable-gold','affinity-for-tokens','creates-token-of-a-card','counter-fuel','counter-fuel-pt','counter-fuel-any','counter-fuel-energy','counter-fuel-loyalty','tutor-creature','tutor-artifact','tutor-land','tutor-enchantment','tutor-instant','tutor-sorcery','tutor-planeswalker','tutor-battle','tutor-legendary','tutor-color','gives-flying','gives-haste','gives-trample','gives-deathtouch','gives-lifelink','gives-menace','gives-hexproof','gives-indestructible','gives-first-strike','gives-double-strike','gives-vigilance','gives-flash','gives-evasion','gives-unblockable','gives-protection','gives-reach','repeatable-draw','repeatable-card-advantage','repeatable-impulse','repeatable-loot','repeatable-rummage','draw-matters','draw-to-seven','discard-outlet','discard-symmetrical','discard-matters','brainstorm','mana-fix','mana-filter','mana-increaser','mana-producer','mana-storage','utility-land','cost-reducer','cost-reducer-instant-sorcery','cost-reducer-creature','cost-reducer-artifact','free-cast-another','extra-land','extra-untap','extra-combat-phase','extra-draw-step','mana-value-matters','mass-reanimation','reanimate-creature','reanimate-from-any','leaving-graveyard-matters','castable-from-graveyard','sacrifice-matters','opponent-sacrifices','opponent-sacrifice-matters','mutual-sacrifice','free-sacrifice-outlet','repeatable-sacrifice-outlet','opponent-loses-life','life-loss-matters','lifegain-matters','opponent-lifegain','cards-in-exile-matter','castable-from-exile','storm-like','storm-count-matters','magecraft','landfall','land-count-matters','hand-size-matters','monarch-matters','sacrifice-outlet-creature','sacrifice-outlet-artifact','alternate-win-condition','lose-trigger','prevents-win-loss']);
/* The Oracle Tags bulk file turned out to be a DICTIONARY — 4,500+ rows
   defining which tags exist (label, description, hierarchy), with no card
   memberships at all. So it feeds the browsable tags-index.json, while the
   memberships are gathered the other way round: one paged Scryfall search
   per APP_TAG, run weekly from this machine — ~150 polite requests total
   instead of 17 per card per phone. */
export function tagDictEntry(rec){
  if(!rec || typeof rec !== 'object') return null;
  if(rec.type && rec.type !== 'oracle') return null;   // art tags stay out
  const slug = rec.slug || rec.label;
  if(!slug) return null;
  return { slug: String(slug), description: rec.description ? String(rec.description) : '' };
}
export async function tagMembers(tag, fetchImpl, delayMs, budget){
  const f = fetchImpl || fetch;
  const oids = new Set();
  const wait = (ms)=>new Promise(res=>setTimeout(res, ms));
  let url = 'https://api.scryfall.com/cards/search?unique=cards&q=' + encodeURIComponent('otag:' + tag);
  let retries = 0;
  for(let page = 0; url && page < 60; page++){
    const r = await f(url, UA);
    if(!r.ok && r.status !== 404){
      // 429, 403, 5xx — all of it is the throttle talking, and its windows
      // are LONG. Short backoffs burned retries and zeroed REAL tags
      // (boardwipe, lifegain, token-generator...). Wait a full minute,
      // then longer — within the run's overall patience budget.
      const pause = 60000 + 30000 * retries;
      if(++retries > 8 || (budget && (budget.ms -= pause) < 0)){
        console.log(`  otag:${tag}: throttled out (last ${r.status}) at page ${page}${budget && budget.ms < 0 ? ' — patience budget spent' : ''}`);
        break;
      }
      await wait(pause);
      page--;
      continue;
    }
    if(!r.ok) break;                                   // a TRUE 404: the tag has no cards
    retries = 0;
    const d = await r.json();
    (d.data || []).forEach(c=>{ if(c && c.oracle_id) oids.add(c.oracle_id); });
    url = d.has_more ? d.next_page : null;
    if(url) await wait(delayMs == null ? 500 : delayMs);
  }
  return oids;
}
/* ---- stream a GIANT JSON array without ever holding it whole ----
   Commander Spellbook's variants.json is bigger than Node's maximum
   string (the 0x1ffffe8 crash) — so this walks the byte stream and
   yields one top-level array element at a time: quote/escape-aware,
   multibyte-safe, constant memory. */
export async function* jsonArrayItems(stream){
  const dec = new StringDecoder('utf8');
  let buf = '', pos = 0, inStr = false, esc = false;
  let inArr = false, arrDepth = 0;     // the FIRST array is the one we want —
  let objDepth = 0, objStart = -1;     // variants.json wraps it in an object
  for await (const chunk of stream){
    buf += dec.write(chunk);
    while(pos < buf.length){
      const ch = buf[pos];
      if(inStr){
        if(esc) esc = false;
        else if(ch === '\\') esc = true;
        else if(ch === '"') inStr = false;
      }else if(ch === '"'){ inStr = true; }
      else if(!inArr){
        if(ch === '[') inArr = true;               // found the array — everything before was wrapper
      }else if(objStart < 0){
        if(ch === '{'){ objStart = pos; objDepth = 1; }
        else if(ch === '[') arrDepth++;
        else if(ch === ']'){ if(arrDepth > 0) arrDepth--; else inArr = false; }
      }else{
        if(ch === '{') objDepth++;
        else if(ch === '}'){
          objDepth--;
          if(objDepth === 0){
            yield JSON.parse(buf.slice(objStart, pos + 1));
            buf = buf.slice(pos + 1); pos = -1; objStart = -1;
          }
        }
      }
      pos++;
    }
    // Constant memory: the state machine survives buffer wipes, so anything
    // between objects (wrapper keys, separators) can be dropped freely.
    if(objStart < 0 && buf.length > 4096){ buf = ''; pos = 0; }
    else if(objStart > 0){ buf = buf.slice(objStart); pos -= objStart; objStart = 0; }
  }
}
/* One Commander Spellbook variant, trimmed — or null when unusable:
   template combos (arbitrary extra cards), wrong sizes, or non-commander. */
export function comboRecordOf(v){
  if(!v || typeof v !== 'object') return null;
  if(Array.isArray(v.requires) && v.requires.length) return null;
  if(v.status && String(v.status).toUpperCase() !== 'OK') return null;
  const nm = (v.uses || []).map(u=>u && u.card && u.card.name).filter(Boolean);
  if(nm.length < 2 || nm.length > 4) return null;
  const leg = v.legalities || v.legal || null;
  if(leg && leg.commander === false) return null;
  const r = (v.produces || []).map(p=>(p && ((p.feature && p.feature.name) || p.name)) || '').filter(Boolean).join(' · ');
  return { nm, r, i: v.identity || '' };
}
export function groupRuling(map, r){
  if(!r || !r.oracle_id || !r.comment) return;
  let a = map.get(r.oracle_id);
  if(!a){ a = []; map.set(r.oracle_id, a); }
  a.push({ d: r.published_at || '', c: r.comment });
}

async function writeJsonlGz(path, lines){
  await pipeline(Readable.from(lines), createGzip({ level: 9 }), createWriteStream(path));
}

/* ---- the daily price file ----
   Default Cards carries every printing, so this is where "cheapest" can
   actually be worked out. Streamed line by line: constant memory, however
   large Scryfall's file grows.

   Deliberately the same rule as cheapestEur() in the app: the lowest
   prices.eur among non-digital printings. Foil prices are left out, exactly
   as the app leaves them out -- a foil is not the cheapest way to own the
   card. */
export function priceOf(card, best){
  if(!card || !card.name || card.digital) return;
  const raw = card.prices && card.prices.eur;
  if(!raw) return;
  const e = Number(raw);
  if(!isFinite(e) || e <= 0) return;
  // Double-faced cards are sold as one card; the app prices them by full name.
  const key = String(card.name).toLowerCase();
  const cur = best.get(key);
  if(cur === undefined || e < cur) best.set(key, e);
}

async function buildPrices(){
  console.log('Fetching bulk-data index\u2026');
  const idx = await bulkIndex();
  const entry = idx.default_cards || idx['default-cards'] || idx.all_cards;
  if(!entry) throw new Error('bulk-data index has no default_cards entry');
  const url = requireDownloadUrl(entry, 'Default Cards');
  console.log('Default Cards:', url);

  const best = new Map();
  let seen = 0;
  for await (const card of bulkLines(url)){
    seen++;
    priceOf(card, best);
    if(seen % 100000 === 0) console.log(`  \u2026${seen} printings read, ${best.size} names priced`);
  }
  console.log(`${seen} printings read, ${best.size} names priced`);
  if(best.size < 15000) throw new Error(`Sanity check failed: only ${best.size} priced names \u2014 refusing to publish a broken file.`);

  // A day where Scryfall served a partial file must not shrink the app's
  // knowledge. Same ratchet the weekly artifacts use.
  let prev = 0;
  try{ prev = gunzipSync(await readFile(`${OUT_DIR}/prices-slim.tsv.gz`)).toString('utf-8').split('\n').filter(Boolean).length; }catch(e){}
  if(prev && best.size < prev * 0.8){
    console.log(`Thinner than yesterday (${best.size} vs ${prev}) \u2014 keeping yesterday's file.`);
    return;
  }

  // Sorted, so an unchanged day produces a byte-identical file and git has
  // nothing to commit.
  const names = Array.from(best.keys()).sort();
  const lines = (function*(){
    for(const n of names) yield n + '\t' + best.get(n).toFixed(2) + '\n';
  })();
  await writeJsonlGz(`${OUT_DIR}/prices-slim.tsv.gz`, lines);
  await writeFile(`${OUT_DIR}/prices-meta.json`, JSON.stringify({
    format: 1,
    built: new Date().toISOString(),
    count: best.size,
    sourceUpdatedAt: entry.updated_at || ''
  }, null, 2) + '\n');
  console.log(`prices-slim.tsv.gz: ${best.size} names. prices-meta.json written. Done.`);
}

/* ---- main ---- */
async function main(){
  console.log('Fetching bulk-data index…');
  const idx = await bulkIndex();
  const oracleUrl  = requireDownloadUrl(idx.oracle_cards, 'Oracle Cards');
  const rulingsUrl = requireDownloadUrl(idx.rulings, 'Rulings');
  console.log('Oracle Cards:', oracleUrl);
  console.log('Rulings:     ', rulingsUrl);

  // Oracle Cards — stream, trim, count, write
  let oracleCount = 0, skipped = 0;
  const oracleOut = [];
  for await (const card of bulkLines(oracleUrl)){
    const t = trimCard(card);
    if(!t){ skipped++; continue; }
    oracleOut.push(JSON.stringify(t) + '\n');
    oracleCount++;
  }
  if(oracleCount < 25000) throw new Error(`Sanity check failed: only ${oracleCount} oracle cards — refusing to publish a broken file.`);
  await writeJsonlGz(`${OUT_DIR}/oracle-slim.jsonl.gz`, oracleOut);
  console.log(`oracle-slim.jsonl.gz: ${oracleCount} cards (${skipped} skipped)`);

  // Rulings — group by oracle_id, write
  const rmap = new Map();
  let rulingCount = 0;
  for await (const r of bulkLines(rulingsUrl)){
    groupRuling(rmap, r);
    rulingCount++;
  }
  if(rulingCount < 20000) throw new Error(`Sanity check failed: only ${rulingCount} rulings — refusing to publish a broken file.`);
  const rulingLines = (function*(){
    for(const [oid, arr] of rmap) yield JSON.stringify({ o: oid, r: arr }) + '\n';
  })();
  await writeJsonlGz(`${OUT_DIR}/rulings-slim.jsonl.gz`, rulingLines);
  console.log(`rulings-slim.jsonl.gz: ${rulingCount} rulings on ${rmap.size} cards`);

  // Oracle Tags, part 1: the DICTIONARY — every tag Scryfall knows, with
  // its description, published as browsable tags-index.json. Optional;
  // problems here never sink the job.
  let tagIndexCount = 0;
  try{
    if(!idx._tags){
      console.log('No oracle_tags entry in the bulk index — skipping the tag dictionary.');
    }else{
      const tagsUrl = requireDownloadUrl(idx._tags, 'Oracle Tags');
      console.log('Oracle Tags dictionary:', tagsUrl);
      const dict = [];
      for await (const rec of bulkLines(tagsUrl)){
        const e = tagDictEntry(rec);
        if(e) dict.push(e);
      }
      dict.sort((a, b)=>a.slug.localeCompare(b.slug));
      await writeFile(`${OUT_DIR}/tags-index.json`, JSON.stringify(dict, null, 1) + '\n');
      tagIndexCount = dict.length;
      console.log(`tags-index.json: ${tagIndexCount} oracle tags (browse it on the site)`);
    }
  }catch(e){
    console.log('Tag dictionary step failed — continuing without it:', e && e.message || e);
  }

  // Oracle Tags, part 2: MEMBERSHIPS — one paged search per app tag, from
  // this one machine, weekly. The phones never interrogate again.
  let tagCards = 0;
  try{
    const tmap = new Map();
    // One hour of cumulative throttle-waiting for the whole run — beyond
    // that, remaining tags pass and the ratchet below protects the data.
    const budget = { ms: 60 * 60000 };
    for(const tag of APP_TAGS){
      const oids = await tagMembers(tag, undefined, undefined, budget);
      oids.forEach(oid=>{
        let g = tmap.get(oid);
        if(!g){ g = new Set(); tmap.set(oid, g); }
        g.add(tag);
      });
      console.log(`  otag:${tag} → ${oids.size} cards`);
    }
    // Ratchet: a throttled, thinner run must never erase last week's file.
    let prevCount = 0;
    try{ prevCount = gunzipSync(await readFile(`${OUT_DIR}/tags-slim.jsonl.gz`)).toString('utf-8').split('\n').filter(Boolean).length; }catch(e){}
    if(tmap.size < 1000 || tmap.size < prevCount * 0.8){
      console.log(`Tag memberships thinner than the previous run (${tmap.size} vs ${prevCount}) — keeping the previous file.`);
      tagCards = prevCount;
    }else{
      const lines = (function*(){ for(const [oid, g] of tmap) yield JSON.stringify({ o: oid, g: Array.from(g) }) + '\n'; })();
      await writeJsonlGz(`${OUT_DIR}/tags-slim.jsonl.gz`, lines);
      tagCards = tmap.size;
      console.log(`tags-slim.jsonl.gz: ${tagCards} tagged cards across ${APP_TAGS.size} tags`);
    }
}catch(e){
    console.log('Tag membership step failed — continuing without it:', e && e.message || e);
  }

  // Commander Spellbook combos — optional artifact; problems here never
  // sink the job. Source URLs are tried in order and self-document.
  let comboCount = 0;
  try{
    // The bulk file is larger than Node's maximum string — STREAM it,
    // one variant at a time, constant memory.
    const CANDIDATE_URLS = [
      'https://json.commanderspellbook.com/variants.json',
      'https://spellbook-prod.s3.us-east-2.amazonaws.com/variants.json',
    ];
    let out = null, used = '', seen = 0; const samples = [];
    for(const u of CANDIDATE_URLS){
      try{
        const r = await fetch(u, UA);
        if(!r.ok || !r.body){ console.log('combos: ' + u + ' -> HTTP ' + r.status); continue; }
        out = []; seen = 0; used = u;
        for await (const v of jsonArrayItems(Readable.fromWeb(r.body))){
          seen++;
          if(samples.length < 2) samples.push(JSON.stringify(v).slice(0, 300));
          const rec = comboRecordOf(v);
          if(rec) out.push(rec);
          if(seen % 50000 === 0) console.log(`  …${seen} variants read, ${out.length} kept`);
        }
        break;
      }catch(e){ console.log('combos: ' + u + ' -> ' + (e && e.message || e)); out = null; }
    }
    if(!out){
      console.log('Combos: no source answered — skipping this week.');
    }else{
      console.log('Combos source:', used, '(' + seen + ' variants streamed)');
      if(out.length < 4000){
        console.log(`Combos parsed thin (${out.length} of ${seen}) — refusing to publish. Sample variants:`);
        samples.forEach(x=>console.log('  ', x));
      }else{
        let prev = 0;
        try{ prev = gunzipSync(await readFile(`${OUT_DIR}/combos-slim.jsonl.gz`)).toString('utf-8').split('\n').filter(Boolean).length; }catch(e){}
        if(out.length < prev * 0.8){
          console.log(`Combos thinner than the previous run (${out.length} vs ${prev}) — keeping the previous file.`);
          comboCount = prev;
        }else{
          await writeJsonlGz(`${OUT_DIR}/combos-slim.jsonl.gz`, (function*(){ for(const c of out) yield JSON.stringify(c) + '\n'; })());
          comboCount = out.length;
          console.log(`combos-slim.jsonl.gz: ${comboCount} combos (2–4 cards, commander-legal)`);
        }
      }
    }
  }catch(e){
    console.log('Combos step failed — continuing without it:', e && e.message || e);
  }

  // Manifest — the app polls this tiny file to know when to refresh
  const meta = {
    format: 1,
    built: new Date().toISOString(),
    oracle:  { count: oracleCount, sourceUpdatedAt: idx.oracle_cards.updated_at },
    rulings: { count: rulingCount, cards: rmap.size, sourceUpdatedAt: idx.rulings.updated_at },
    tags:    { cards: tagCards, index: tagIndexCount },
    combos:  { count: comboCount }
  };
  await writeFile(`${OUT_DIR}/bulk-meta.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log('bulk-meta.json written. Done.');
}

const runDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if(runDirectly && !process.env.BULK_NO_MAIN){
  const pricesOnly = process.argv.includes('--prices') || process.env.BULK_MODE === 'prices';
  (pricesOnly ? buildPrices() : main()).catch(e=>{ console.error(e); process.exit(1); });
}
