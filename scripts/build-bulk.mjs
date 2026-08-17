#!/usr/bin/env node
/* ============================================================
   Weekly Scryfall bulk trimmer — Admirals & Commanders MTG
   ============================================================
   Runs on GitHub Actions (see .github/workflows/bulk-data.yml).
   Downloads the official Oracle Cards and Rulings bulk files,
   keeps only the fields the app uses, and writes into the repo
   root (deployed by Netlify next to index.html):

     oracle-slim.jsonl.gz    one trimmed card per line
     rulings-slim.jsonl.gz   one {o, r:[{d,c}]} line per oracle_id
     bulk-meta.json          tiny manifest the app can poll cheaply

   Plus two optional tag artifacts (problems here never sink the job):
     tags-index.json         every oracle tag Scryfall knows, browsable
     tags-slim.jsonl.gz      one {o, g:[tags]} line per tagged card,
                             gathered by ONE paged search per app tag
                             from this machine — phones never probe.

   The phone never touches the raw 148 MB — all trimming happens
   on GitHub's machines, and Scryfall sees one bulk download plus
   the weekly tag sweep, politely paced and throttle-patient.

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
  if(eurf != null && !Number.isNaN(eurf)) o.eurf = eurf;
  if(c.edhrec_rank) o.rk = c.edhrec_rank;
  if(c.game_changer) o.gc = 1;
  if(c.card_faces && c.card_faces.length) o.f = c.card_faces.map(trimFace);
  return o;
}

/* Only the tags the app actually consults — everything else is trimmed. */
export const APP_TAGS = new Set(['removal','creature-removal','artifact-removal','enchantment-removal','planeswalker-removal','spot-removal','boardwipe','edict','bounce','mass-bounce','tuck','exile','fight','bite','burn','sweep-damage','counterspell','soft-counterspell','tax-counterspell','redirect','land-destruction','mass-land-destruction','threaten','sacrifice-outlet','forced-sacrifice','stifle','ramp','mana-rock','mana-dork','ritual','land-ramp','extra-lands','cost-reduction','mana-doubler','mana-sink','untapper','treasure','gold','mana-fixing','lands-matter','landfall-payoff','cheat-into-play','free-spell','alternative-cost','x-spell','draw','cantrip','card-advantage','wheel','impulse','looting','rummage','tutor','creature-tutor','land-tutor','artifact-tutor','enchantment-tutor','instant-tutor','sorcery-tutor','equipment-tutor','aura-tutor','planeswalker-tutor','battle-tutor','topdeck','peek','reveal','draw-engine','draw-punisher','extra-card','mill','self-mill','discard','madness-enabler','reanimate','recursion','regrowth','graveyard-hate','self-recursion','delve-fodder','escape-enabler','token-generator','treasure-token','clue','food','blood-token','token-doubler','populate','anthem','overrun','pump','counters-matter','plus-one-counter','proliferate','counter-doubler','charge-counter','experience-counter','poison','infect','protection','hexproof-granter','indestructible-granter','phase-out','fog','prevent-damage','lifegain','lifegain-payoff','stax','tax','hatebear','silence','rule-of-law','pillowfort','no-attack','ward-granter','totem-armor','regenerate','damage-doubler','extra-combat','extra-attack','evasion','unblockable','menace-granter','flying-granter','trample-granter','deathtouch-granter','first-strike-granter','double-strike-granter','lure','vigilance-granter','haste-granter','attack-trigger','combat-trick','blink','flicker','clone','copy-spell','copy-permanent','copy-trigger','untap-engine','sacrifice-fodder','aristocrats','death-trigger','enter-the-battlefield','leaves-the-battlefield','cast-trigger','spellslinger','enrage-enabler','self-sacrifice','goad','monarch','initiative','group-hug','group-slug','voting','tempting-offer','join-forces','curse','donate','redirect-attack','council','wincon','alternate-win','extra-turn','infinite-combo','combo-piece','commander-damage','voltron','equipment-matters','aura-matters','vehicle','big-mana','finisher','game-ender','chaos']);
/* The Oracle Tags bulk file turned out to be a DICTIONARY — 4,500+ rows
   defining which tags exist (label, description, hierarchy), with no card
   memberships at all. So it feeds the browsable tags-index.json, while the
   memberships are gathered the other way round: one paged Scryfall search
   per APP_TAG, run weekly from this machine. */
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
export function groupRuling(map, r){
  if(!r || !r.oracle_id || !r.comment) return;
  let a = map.get(r.oracle_id);
  if(!a){ a = []; map.set(r.oracle_id, a); }
  a.push({ d: r.published_at || '', c: r.comment });
}

async function writeJsonlGz(path, lines){
  await pipeline(Readable.from(lines), createGzip({ level: 9 }), createWriteStream(path));
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

  // Manifest — the app polls this tiny file to know when to refresh
  const meta = {
    format: 1,
    built: new Date().toISOString(),
    oracle:  { count: oracleCount, sourceUpdatedAt: idx.oracle_cards.updated_at },
    rulings: { count: rulingCount, cards: rmap.size, sourceUpdatedAt: idx.rulings.updated_at },
    tags:    { cards: tagCards, index: tagIndexCount }
  };
  await writeFile(`${OUT_DIR}/bulk-meta.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log('bulk-meta.json written. Done.');
}

const runDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if(runDirectly && !process.env.BULK_NO_MAIN){
  main().catch(e=>{ console.error(e); console.error(e && e.stack || ''); process.exit(1); });
                                 }
