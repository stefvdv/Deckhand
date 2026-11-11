// Deckhand — weekly EDHREC summary.
//
// Fetches the EDHREC pages the app opens most (the theme and kindred
// catalogues, the most played themes and kindred, the most played
// commanders), keeps only what the app reads from them, and writes ONE file:
// data/edhrec-slim.json.gz = { built, pages: { "<path>": <slim page> } }.
//
// The app loads it once a week in the background and puts every page in its
// own EDHREC cache, so Inspiration and deck recommendations open at once,
// offline too. The app still fetches the live page in the background, so it
// never stays more than a few days behind EDHREC.
//
// It also keeps a short profile of the ~700 most played commanders (how
// strong, how expensive, how much the table hates it, its themes): the
// deck guide ("Which deck suits me?") picks commanders from these.
//
// Polite: one request at a time with a pause between them, once a week.
//
//   node scripts/build-edhrec.mjs --out data/edhrec-slim.json.gz   (also writes data/edhrec-meta.json)
//        [--themes 120] [--typal 40] [--commanders 100] [--profiles 700] [--delay 300]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'data/edhrec-slim.json.gz');
const N_THEMES = +arg('themes', 120), N_TYPAL = +arg('typal', 40), N_CMD = +arg('commanders', 100);
const DELAY = +arg('delay', 300);
const N_PROF = +arg('profiles', 700);
const BASE = 'https://json.edhrec.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(BASE + path, { signal: ctrl.signal, headers: { 'User-Agent': 'Deckhand weekly summary (github.com/stefvdv/Deckhand)' } });
      clearTimeout(t);
      if (res.status === 404 || res.status === 403) return null;
      if (res.ok) {
        const j = await res.json();
        // the same test the app uses: only a real EDHREC page counts
        return j && j.container && j.container.json_dict ? j : null;
      }
    } catch (e) {}
    await sleep(2000 * attempt);
  }
  return null;
}

// Everything the app reads from a card entry; the rest (ids, image
// versions, trend numbers) is dropped.
const CV_KEEP = ['name', 'num_decks', 'potential_decks', 'synergy', 'inclusion', 'label', 'value', 'salt'];
function slimCv(cv, keepUrl) {
  if (!cv || typeof cv !== 'object') return cv;
  const o = {};
  for (const k of CV_KEEP) if (cv[k] != null) o[k] = cv[k];
  if (keepUrl) { if (cv.url) o.url = cv.url; if (cv.sanitized) o.sanitized = cv.sanitized; }
  return o;
}
function slimPage(page, { catalogue = false, cap = 0 } = {}) {
  const jd = (page.container && page.container.json_dict) || {};
  const lists = (jd.cardlists || []).map((L) => ({
    header: L.header, tag: L.tag,
    // commander lists keep 100 (the app shows that many), card lists `cap`
    cardviews: (L.cardviews || []).slice(0, cap ? (/commander/i.test(L.header || '') ? 100 : cap) : undefined).map((cv) => slimCv(cv, catalogue)),
  }));
  const out = { header: page.header, container: { json_dict: { cardlists: lists } } };
  if (jd.card) out.container.json_dict.card = { name: jd.card.name, salt: jd.card.salt };
  const tl = (page.panels && page.panels.taglinks) || (jd.panels && jd.panels.taglinks);
  if (Array.isArray(tl)) out.panels = { taglinks: tl.map((t) => ({ value: t.value, tag: t.tag, slug: t.slug, count: t.count })) };
  else if (page.tag_counts) out.tag_counts = page.tag_counts;
  if (Array.isArray(page.related_info)) {
    out.related_info = page.related_info.map((g) => ({
      items: ((g && g.items) || []).map((it) => ({ textLeft: it.textLeft, count: it.count, colors: it.colors, url: it.url })),
    }));
  }
  return out;
}
// Theme links, the same way the app reads the catalogues.
function tagLinks(page) {
  const out = [], seen = new Set();
  const walk = (n, d) => {
    if (!n || d > 14) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
    if (typeof n !== 'object') return;
    const u = typeof n.url === 'string' ? n.url : '';
    const m = u.match(/^\/(?:tags|typal|themes)\/(?:themes\/|typal\/)?([a-z0-9%+-]+)\/?$/i);
    if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ slug: m[1].toLowerCase(), count: n.num_decks || n.count || 0 }); }
    for (const k in n) walk(n[k], d + 1);
  };
  walk(page, 0);
  return out.sort((a, b) => b.count - a.count);
}

const pages = {};
const profiles = {};
let fetched = 0, missed = 0;
// One commander, in a few numbers: colours, decks, rank, salt, decks per
// power bracket (1-5), per budget (budget / middle / expensive), its top themes.
function profileOf(p) {
  try {
    const c = (p.container.json_dict.card) || {};
    if (!c.name) return null;
    const tl = (p.panels && p.panels.taglinks) || [];
    const br = p.bracket_counts || {}, bu = p.budget_counts || {};
    return {
      n: c.name,
      ci: (c.color_identity || []).join('').toLowerCase(),
      d: c.num_decks || 0,
      r: c.rank || 0,
      sa: Math.round((c.salt || 0) * 100) / 100,
      br: [1, 2, 3, 4, 5].map((k) => br[k] || 0),
      bu: [bu.budget || 0, bu.middle || 0, bu.expensive || 0],
      t: tl.filter((t) => t && t.slug).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 16).map((t) => [t.slug, t.count || 0]),
    };
  } catch (e) { return null; }
}
async function take(path, opts) {
  if (pages[path]) return pages[path];
  await sleep(DELAY);
  const p = await get(path);
  if (!p) { missed++; return null; }
  fetched++;
  if (opts && opts.keep === false) return p;          // read for its profile only
  pages[path] = slimPage(p, opts);
  if (fetched % 25 === 0) console.log(`  ${fetched} pages…`);
  return p;
}

const cat = { catalogue: true };
const themes = await take('/pages/tags/themes.json', cat);
const typal = await take('/pages/tags/typal.json', cat);
await take('/pages/tags.json', cat);
const periods = [];
for (const w of ['week', 'month', 'year']) periods.push(await take('/pages/commanders/' + w + '.json', cat));
await take('/pages/top/salt.json', cat);
if (!themes || !typal) { console.error('EDHREC catalogue missing: not writing a half file.'); process.exit(1); }

const TAG_CAP = 40, CMD_CAP = 60;
const slugs = [
  ...tagLinks(themes).slice(0, N_THEMES).map((t) => t.slug),
  ...tagLinks(typal).slice(0, N_TYPAL).map((t) => t.slug),
];
console.log(`Themes and kindred: ${slugs.length}`);
for (const s of slugs) await take('/pages/tags/' + s + '.json', { cap: TAG_CAP });

// The most played commanders over the week, month and year, merged.
const score = new Map();
for (const per of periods) {
  if (!per) continue;
  for (const L of per.container.json_dict.cardlists || []) for (const cv of L.cardviews || []) {
    if (!cv || !cv.sanitized) continue;
    score.set(cv.sanitized, Math.max(score.get(cv.sanitized) || 0, cv.num_decks || 0));
  }
}
const cmds = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, N_CMD).map((x) => x[0]);
console.log(`Commanders: ${cmds.length}`);
for (const c of cmds) { const p = await take('/pages/commanders/' + c + '.json', { cap: CMD_CAP }); const pf = p && profileOf(p); if (pf) profiles[c] = pf; }

// Profiles: the most played commanders of every colour combination (EDHREC's
// colour pages), so a guide answer like "mono-white" always has candidates.
const COLOR_PAGES = ['mono-white', 'mono-blue', 'mono-black', 'mono-red', 'mono-green', 'colorless',
  'azorius', 'dimir', 'rakdos', 'gruul', 'selesnya', 'orzhov', 'izzet', 'golgari', 'boros', 'simic',
  'esper', 'grixis', 'jund', 'naya', 'bant', 'abzan', 'jeskai', 'sultai', 'mardu', 'temur',
  'yore-tiller', 'glint-eye', 'dune-brood', 'ink-treader', 'witch-maw', 'five-color'];
const pool = new Map();
const perColor = [];
for (const cp of COLOR_PAGES) {
  await sleep(DELAY);
  const p = await get('/pages/commanders/' + cp + '.json');
  if (!p) { missed++; continue; }
  const list = [];
  for (const L of p.container.json_dict.cardlists || []) for (const cv of L.cardviews || []) {
    if (!cv || !cv.sanitized) continue;
    list.push([cv.sanitized, cv.num_decks || 0]);
    pool.set(cv.sanitized, Math.max(pool.get(cv.sanitized) || 0, cv.num_decks || 0));
  }
  perColor.push(list.sort((a, b) => b[1] - a[1]));
}
// every colour's top 12 first, then the most played overall
const want = [];
const seen = new Set(Object.keys(profiles));
perColor.forEach((list) => list.slice(0, 12).forEach(([s]) => { if (!seen.has(s)) { seen.add(s); want.push(s); } }));
[...pool.entries()].sort((a, b) => b[1] - a[1]).forEach(([s]) => { if (!seen.has(s)) { seen.add(s); want.push(s); } });
const need = Math.max(0, N_PROF - Object.keys(profiles).length);
console.log(`Profiles: ${Object.keys(profiles).length} from the pages above, ${Math.min(need, want.length)} more to read`);
for (const s of want.slice(0, need)) {
  const p = await take('/pages/commanders/' + s + '.json', { keep: false });
  const pf = p && profileOf(p);
  if (pf) profiles[s] = pf;
}

const built = Date.now();
const body = JSON.stringify({ built, pages, profiles });
const gz = gzipSync(body, { level: 9 });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, gz);
// the small file the app checks first, so it downloads the big one only once a week
writeFileSync(join(dirname(OUT), 'edhrec-meta.json'), JSON.stringify({ built, pages: Object.keys(pages).length, profiles: Object.keys(profiles).length, bytes: gz.length }) + '\n');
console.log(`Wrote ${OUT}: ${Object.keys(pages).length} pages, ${Object.keys(profiles).length} profiles (${missed} missing), ${(body.length / 1048576).toFixed(1)} MB → ${(gz.length / 1048576).toFixed(2)} MB gzip`);
