#!/usr/bin/env node
/* Deckhand — weekly metagame build for the constructed formats.

   Input (both are open data on GitHub, checked out by the workflow):
     --cache  MTGODecklistCache checkout (Jiliac fork): tournament JSON files
              under Tournaments/<source>/<yyyy>/<mm>/<dd>/*.json
     --rules  MTGOFormatData checkout (Badaro): archetype rules per format
   Output:
     --out    meta.json next to index.html

   What it does, per format (Standard, Pauper, Modern, Legacy, Vintage):
     1. takes every deck from the last --days days (default 28), ending at the
        newest tournament date found in the cache,
     2. names each deck with the community's own archetype rules (the same
        rules MTGOArchetypeParser uses) -- rule match first, then the
        "fallback" piles by shared common cards,
     3. counts decks per archetype (that count IS "most played"), picks the
        best-finishing list as the representative decklist, picks a key card
        for the tile art, and files the archetype under a play style
        (aggro / tempo / midrange / control / combo / ramp).
   Hand corrections live in scripts/meta-overrides.json (names, styles, key
   cards) so a new week never loses them.

   No network access here: the workflow does the checkouts. */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr)=>{
  if(a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']);
  return acc;
}, []));
const CACHE = args.cache || 'MTGODecklistCache';
const RULES = args.rules || 'MTGOFormatData';
const OUT = args.out || 'meta.json';
const DAYS = Math.max(7, Math.min(60, parseInt(args.days || '28', 10) || 28));
const HERE = path.dirname(new URL(import.meta.url).pathname);

export const FORMATS = { standard: 'Standard', pauper: 'Pauper', modern: 'Modern', legacy: 'Legacy', vintage: 'Vintage' };
const SOURCES = ['mtgo.com_limited_data', 'melee.gg', 'mtgo.com', 'topdeck.gg', 'manatraders.com', 'CardsRealm'];
/* Colourless lands card_colors files among the nonlands. Without the card
   file (local runs) these would otherwise win the key-card vote. */
const COLORLESS_LANDS = new Set(["Ancient Tomb","Mishra's Workshop","Urza's Tower","Urza's Mine","Urza's Power Plant","Eldrazi Temple","Cloudpost","Glimmerpost","Bazaar of Baghdad","Tolarian Academy","Strip Mine","Wasteland","Library of Alexandria","Karakas","Urza's Saga","Eye of Ugin","The Tabernacle at Pendrell Vale","Gemstone Caverns","City of Traitors","Crystal Vein","Mishra's Factory","Mutavault","Castle Doom","Great Hall of the Biblioplex","Multiversal Passage","Otawara, Soaring City","Boseiju, Who Endures","Urza's Cave"]);
/* Removal and cantrips that half the format plays: true, but not what the
   deck is ABOUT. They only become the key card when nothing else stands out. */
const STAPLES = new Set(["Fatal Push","Swords to Plowshares","Lightning Bolt","Counterspell","Thoughtseize","Force of Will","Brainstorm","Ponder","Preordain","Stifle","Daze","Consider","Opt","Spell Pierce","Prismatic Ending","Solitude","Orcish Bowmasters","Mishra's Bauble","Unholy Heat","Pyroblast","Red Elemental Blast","Force of Negation","Snuff Out","Cast Down","Galvanic Blast","Thought Scour","Mental Note","Duress","Inquisition of Kozilek","Tishana's Tidebinder","Get Lost","Cut Down","Go for the Throat","Portable Hole","Stoneforge Mystic"]);
const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', 'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest']);

/* The rule files are hand-edited JSON; a few carry trailing commas or
   comments. Read them the forgiving way instead of dropping an archetype. */
export function looseJson(text){
  let t = String(text).replace(/^﻿/, '');
  t = t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  t = t.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(t);
}
function readJsonFile(p){
  try{ return looseJson(fs.readFileSync(p, 'utf8')); }
  catch(e){ console.warn('  ! unreadable rule file skipped: ' + p + ' (' + e.message + ')'); return null; }
}

/* ---------------------------------------------------------------- names */
/* The rule files mix "Death & Taxes", "AdNauseam" and "GenericTron". The
   app shows names people use, so CamelCase is split and the parser's
   internal prefixes go. Anything still odd is fixed in the overrides. */
export function prettyName(raw){
  let n = String(raw || '').trim();
  if(!/\s/.test(n)) n = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  n = n.replace(/^Generic\s+/i, '').replace(/\s{2,}/g, ' ').trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}
const COLOR_NAMES = {
  '': 'Colorless', W: 'Mono White', U: 'Mono Blue', B: 'Mono Black', R: 'Mono Red', G: 'Mono Green',
  WU: 'Azorius', UB: 'Dimir', BR: 'Rakdos', RG: 'Gruul', WG: 'Selesnya', WB: 'Orzhov', UR: 'Izzet', BG: 'Golgari', WR: 'Boros', UG: 'Simic',
  WUB: 'Esper', UBR: 'Grixis', BRG: 'Jund', WRG: 'Naya', WUG: 'Bant', WBG: 'Abzan', WUR: 'Jeskai', UBG: 'Sultai', WBR: 'Mardu', URG: 'Temur',
  UBRG: '4c', WBRG: '4c', WURG: '4c', WUBG: '4c', WUBR: '4c', WUBRG: '5c'
};
/* "Mono Red Red Rally", "Mono Blue Blue Belcher": a name that already
   carries a colour word gets no second one in front of it. */
const COLOR_WORDS = /^(mono|white|blue|black|red|green|colou?rless|azorius|dimir|rakdos|gruul|selesnya|orzhov|izzet|golgari|boros|simic|esper|grixis|jund|naya|bant|abzan|jeskai|sultai|mardu|temur|[2-5]c|[WUBRG]{1,5})\b/i;
export function withColorName(colorKeyStr, base){
  if(COLOR_WORDS.test(base)) return base;
  return colorName(colorKeyStr) + ' ' + base;
}
export function colorKey(set){ return 'WUBRG'.split('').filter(c=>set.has(c)).join(''); }
export function colorName(key){ return COLOR_NAMES[key] || (key.length >= 4 ? key.length + 'c' : key); }

/* -------------------------------------------------------------- colours */
function loadColors(rulesDir, fmtDir, types){
  const all = readJsonFile(path.join(rulesDir, 'Formats', 'card_colors.json')) || {};
  const over = readJsonFile(path.join(rulesDir, 'Formats', fmtDir, 'color_overrides.json')) || {};
  const lands = new Map(), nonlands = new Map();
  (all.Lands || []).forEach(x=>lands.set(x.Name, x.Color || ''));
  (all.NonLands || []).forEach(x=>nonlands.set(x.Name, x.Color || ''));
  (over.Lands || []).forEach(x=>lands.set(x.Name, x.Color || ''));
  (over.NonLands || []).forEach(x=>nonlands.set(x.Name, x.Color || ''));
  return { lands, nonlands, types: types || null };
}
/* The app's own weekly card file, when the workflow has it: name -> type line. */
export function loadTypes(file){
  if(!file || !fs.existsSync(file)) return null;
  try{
    const raw = fs.readFileSync(file);
    const text = /\.gz$/.test(file) ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const m = new Map();
    for(const line of text.split('\n')){
      if(!line || line[0] !== '{') continue;
      try{ const o = JSON.parse(line); if(o && o.n && o.tl) m.set(o.n, o.tl); }catch(e){}
    }
    return m.size ? m : null;
  }catch(e){ console.warn('  ! card file unreadable: ' + e.message); return null; }
}
/* A deck's colours: what its spells ask for. One stray copy of a card
   in a colour the mana base barely supports is a rounding error, not a
   colour -- it needs two copies, or one copy plus real land support. */
export function deckColors(main, colors){
  const spell = {}, land = {};
  for(const [name, n] of main){
    if(colors.lands.has(name) || BASICS.has(name)){
      const c = colors.lands.get(name) || '';
      for(const ch of c) land[ch] = (land[ch] || 0) + n;
      continue;
    }
    const c = colors.nonlands.get(name);
    if(c == null) continue;
    for(const ch of c) spell[ch] = (spell[ch] || 0) + n;
  }
  // Hybrid cards list every colour they could be paid with, so spells alone
  // over-count (a mono-red deck with one hybrid card read as Grixis). A
  // colour counts when the mana base backs it up -- or, where the lands are
  // unknown or colourless on paper (fetches, new sets), when the spells ask
  // for it often enough that the deck cannot be doing without.
  const out = new Set();
  for(const ch of 'WUBRG'){
    const s = spell[ch] || 0, l = land[ch] || 0;
    if((s >= 2 && l >= 1) || s >= 6) out.add(ch);
  }
  return out;
}
/* Land or not. With the app's own card file (--cards) that is the type
   line. Without it, card_colors knows coloured lands and every nonland
   card up to its last update; a name it has never heard of might be a new
   colourless land, so it is not trusted as a nonland either. */
function isLandName(name, colors){
  if(BASICS.has(name)) return true;
  if(colors.types && colors.types.has(name)) return /\bLand\b/.test(colors.types.get(name).split('//')[0]);
  return colors.lands.has(name) || COLORLESS_LANDS.has(name);
}
function isKnownNonland(name, colors){
  if(colors.types && colors.types.has(name)) return !isLandName(name, colors);
  return colors.nonlands.has(name) && !COLORLESS_LANDS.has(name);
}
function artScore(name, colors){
  // Creatures and planeswalkers make the better tile: a face, not a text box.
  if(!colors.types || !colors.types.has(name)) return 0;
  return /Creature|Planeswalker/.test(colors.types.get(name).split('//')[0]) ? 0.05 : 0;
}

/* ---------------------------------------------------------------- rules */
function loadRules(rulesDir, fmtDir){
  const base = path.join(rulesDir, 'Formats', fmtDir);
  const list = (dir)=>{
    const d = path.join(base, dir);
    if(!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(f=>f.endsWith('.json')).sort().map(f=>readJsonFile(path.join(d, f))).filter(Boolean);
  };
  return { archetypes: list('Archetypes'), fallbacks: list('Fallbacks') };
}
function condMatch(cond, main, side){
  const cards = cond.Cards || [];
  const inM = (c)=>main.has(c), inS = (c)=>side.has(c), inB = (c)=>main.has(c) || side.has(c);
  const count = (pred)=>cards.filter(pred).length;
  switch(cond.Type){
    case 'InMainboard': return cards.every(inM);
    case 'InSideboard': return cards.every(inS);
    case 'InMainOrSideboard': return cards.every(inB);
    case 'OneOrMoreInMainboard': return count(inM) >= 1;
    case 'OneOrMoreInSideboard': return count(inS) >= 1;
    case 'OneOrMoreInMainOrSideboard': return count(inB) >= 1;
    case 'TwoOrMoreInMainboard': return count(inM) >= 2;
    case 'TwoOrMoreInSideboard': return count(inS) >= 2;
    case 'TwoOrMoreInMainOrSideboard': return count(inB) >= 2;
    case 'DoesNotContain': return !cards.some(inB);
    case 'DoesNotContainMainboard': return !cards.some(inM);
    case 'DoesNotContainSideboard': return !cards.some(inS);
    default: return false;
  }
}
const condsMatch = (conds, main, side)=>(conds || []).every(c=>condMatch(c, main, side));
/* The cards a rule leans on, strongest first: required singles, then the
   one-or-more pools. These are what the archetype IS about. */
function ruleCards(rule){
  const req = [], pool = [];
  (rule.Conditions || []).forEach(c=>{
    if(/^In(Main|MainOr)/.test(c.Type)) req.push(...(c.Cards || []));
    else if(/^(One|Two)OrMoreIn(Main|MainOr)/.test(c.Type)) pool.push(...(c.Cards || []));
  });
  return req.concat(pool);
}
export function classifyDeck(main, side, rules){
  const hits = [];
  for(const a of rules.archetypes){
    if(!condsMatch(a.Conditions, main, side)) continue;
    let pick = a;
    for(const v of (a.Variants || [])){ if(condsMatch(v.Conditions, main, side)){ pick = Object.assign({}, v, { _parent: a }); break; } }
    hits.push({ rule: pick, specificity: (a.Conditions || []).length + (pick !== a ? (pick.Conditions || []).length : 0) });
  }
  if(hits.length){
    hits.sort((x, y)=>y.specificity - x.specificity || String(x.rule.Name).localeCompare(String(y.rule.Name)));
    return { kind: 'rule', rule: hits[0].rule };
  }
  // Piles: the fallback sharing the most of its common cards, at least 10%.
  let best = null, bestScore = 0;
  for(const f of rules.fallbacks){
    const cc = f.CommonCards || [];
    if(!cc.length) continue;
    const got = cc.filter(c=>main.has(c) || side.has(c)).length;
    const score = got / cc.length;
    if(score > bestScore){ bestScore = score; best = f; }
  }
  if(best && bestScore >= 0.1) return { kind: 'fallback', rule: best };
  return null;
}

/* ---------------------------------------------------------------- style */
/* Play style from the archetype's name. Ordered: the first pattern that
   fits wins, so "Reanimator" is combo before "Red" makes it aggro. The
   overrides file has the last word for anything this gets wrong. */
const STYLE_RULES = [
  ['ramp',    /\b(tron|ramp|titan|amulet|post|cradle|nykthos|devotion|lands|depths|valakut|mud|karn|eldrazi ramp|urza)\b/i],
  ['combo',   /\b(storm|combo|breach|belcher|oops|doomsday|nauseam|reanimator|dredge|living end|scapeshift|twin|kiki|oracle|thopter|inverter|song of creation|neobrand|goryo|show and tell|sneak|painter|hive mind|tes|tendrils|high tide|food chain|aluren|cephalid|mystic forge|tinker|ritual|glimpse|spy|fling|creativity|soultrader|heliod|devoted|manufactor|taking turns|twiddle|smallpox|oath|hogaak|footfalls|bloom|recor|welder|worldgorger|equilibrium|sibylline|incinerator|riddlesmith|thought lash|bombardiers|misfortune|mortality|agatha|discover|echo of eons|deadly brew|charbelcher|stiflenought|galvanic|zubera|petal|broodscale|kethis|kci|walls|tireless|synthesizer|dice factory|vivien|saheeli|omniscience|cosmo|rack|thassa|underworld|lotus|beseech|pestilence|cat ?altar|land spy|gyruda|madness combo|necro|song)\b/i],
  ['control', /\b(control|prison|lantern|stax|miracles?|teachings|fog|mill|whir|pyro|shops|jewel|narset|coffers|martyr|enduring ideal|helm|tortex)\b/i],
  ['tempo',   /\b(delver|tempo|murktide|faeries|ninjas|flash|spirits|terror|frog|phoenix|free spells|initiative|mono u aggro|affinity for|dimir|izzet)\b/i],
  ['aggro',   /\b(aggro|burn|prowess|zoo|affinity|hammer|stompy|bogles|infect|humans?|goblins|elves|slivers|heroic|kuldotha|energy|madness|red|white|bully|taxes|vial|soul sisters|rally|zombies|knights|rogues|winota|samwise|cutter|convoke|mentor|artos|shadow|bushwhacker|kiln fiend|familiars|gates|merfolk|cascade|landfall|clerics|elementals|wizards|stoneblade|aura|poison|proliferate|slime|monkey|rebel|soldier|breya|bloodforged|hogaak)\b/i],
  ['midrange',/./]
];
export function styleOf(name){
  for(const [s, re] of STYLE_RULES) if(re.test(name)) return s;
  return 'midrange';
}

/* -------------------------------------------------------------- results */
/* A deck's finish, as one sortable number: event placing first (a win in a
   64-player Challenge beats a 5-0 league), then size of the event. */
export function finishScore(result, eventSize){
  const r = String(result || '');
  let s = 0;
  const m = /(\d+)\s*(?:st|nd|rd|th)\s+Place/i.exec(r);
  if(m){ const rank = parseInt(m[1], 10); s = rank <= 1 ? 1000 : rank <= 2 ? 900 : rank <= 4 ? 800 : rank <= 8 ? 700 : Math.max(100, 600 - rank * 5); }
  else if(/^\s*5-0/.test(r)) s = 650;
  else {
    const w = /^(\d+)-(\d+)/.exec(r);
    s = w ? 300 + parseInt(w[1], 10) * 20 - parseInt(w[2], 10) * 25 : 100;
  }
  return s + Math.min(99, eventSize || 0) / 100;
}

/* ------------------------------------------------------------ walk data */
function* walkTournaments(cacheDir, fromIso, toIso){
  const fromY = +fromIso.slice(0, 4), toY = +toIso.slice(0, 4);
  for(const src of SOURCES){
    const root = path.join(cacheDir, 'Tournaments', src);
    if(!fs.existsSync(root)) continue;
    for(let y = fromY; y <= toY; y++){
      const yd = path.join(root, String(y));
      if(!fs.existsSync(yd)) continue;
      for(const mm of fs.readdirSync(yd).sort()){
        const md = path.join(yd, mm);
        if(!fs.statSync(md).isDirectory()) continue;
        for(const dd of fs.readdirSync(md).sort()){
          const iso = `${y}-${mm}-${dd}`;
          if(iso < fromIso || iso > toIso) continue;
          const dayDir = path.join(md, dd);
          if(!fs.statSync(dayDir).isDirectory()) continue;
          for(const f of fs.readdirSync(dayDir)){
            if(!f.endsWith('.json')) continue;
            yield { src, iso, file: path.join(dayDir, f) };
          }
        }
      }
    }
  }
}
function newestDate(cacheDir){
  let best = '';
  for(const src of SOURCES){
    const root = path.join(cacheDir, 'Tournaments', src);
    if(!fs.existsSync(root)) continue;
    const ys = fs.readdirSync(root).filter(x=>/^\d{4}$/.test(x)).sort();
    for(const y of ys.slice(-1)){
      const ms = fs.readdirSync(path.join(root, y)).filter(x=>/^\d{2}$/.test(x)).sort();
      for(const m of ms.slice(-1)){
        const ds = fs.readdirSync(path.join(root, y, m)).filter(x=>/^\d{2}$/.test(x)).sort();
        const d = ds[ds.length - 1];
        if(d && `${y}-${m}-${d}` > best) best = `${y}-${m}-${d}`;
      }
    }
  }
  return best;
}
const isoMinus = (iso, days)=>new Date(Date.parse(iso + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);

/* ------------------------------------------------------------ the build */
export function buildMeta({ cacheDir, rulesDir, days, overrides, today, types }){
  const ov = overrides || {};
  let end = newestDate(cacheDir);
  const now = today || new Date().toISOString().slice(0, 10);
  if(!end || end > now) end = now;
  const from = isoMinus(end, days - 1);
  const byFmt = {};
  Object.keys(FORMATS).forEach(k=>{ byFmt[k] = []; });
  const fmtOf = (s)=>{
    const t = String(s || '').trim().toLowerCase();
    return Object.keys(FORMATS).find(k=>t === k) || null;
  };
  for(const t of walkTournaments(cacheDir, from, end)){
    let j;
    try{ j = JSON.parse(fs.readFileSync(t.file, 'utf8')); }catch(e){ continue; }
    const T = j.Tournament || {};
    const fmt = fmtOf(T.Formats);
    if(!fmt) continue;
    const decks = (j.Decks || []).filter(d=>d && Array.isArray(d.Mainboard) && d.Mainboard.length);
    decks.forEach(d=>{
      byFmt[fmt].push({
        main: new Map(d.Mainboard.map(x=>[x.CardName, x.Count])),
        side: new Map((d.Sideboard || []).map(x=>[x.CardName, x.Count])),
        result: d.Result || '', player: d.Player || '', url: d.AnchorUri || T.Uri || '',
        event: T.Name || '', date: String(T.Date || t.iso).slice(0, 10), size: decks.length, src: t.src
      });
    });
  }
  const out = { format: 1, built: new Date().toISOString(), from, to: end, days,
    source: 'MTGODecklistCache + MTGOFormatData', formats: {} };
  for(const [fmt, dirName] of Object.entries(FORMATS)){
    const decks = byFmt[fmt];
    const rules = loadRules(rulesDir, dirName);
    const colors = loadColors(rulesDir, dirName, types);
    const fo = (ov[fmt] || {});
    const groups = new Map();
    let unknown = 0;
    // How widely each card is played across the whole format -- the base
    // line a key card has to stand out against.
    const allPresence = new Map();
    decks.forEach(d=>{ for(const n of d.main.keys()) allPresence.set(n, (allPresence.get(n) || 0) + 1); });
    decks.forEach(d=>{
      const hit = classifyDeck(d.main, d.side, rules);
      if(!hit){ unknown++; return; }
      const rule = hit.rule;
      const cols = deckColors(d.main, colors);
      const ck = colorKey(cols);
      const withColor = rule.IncludeColorInName || (rule._parent && rule._parent.IncludeColorInName);
      const base = prettyName(rule.Name);
      const baseFixed = (ov.names && ov.names[base]) || (fo.names && fo.names[base]) || base;
      const named = withColor ? withColorName(ck, baseFixed) : baseFixed;
      const name = (fo.rename && fo.rename[named]) || (ov.rename && ov.rename[named]) || named;
      if(!groups.has(name)) groups.set(name, { name, base: baseFixed, kind: hit.kind, rule, decks: [], colors: new Map() });
      const g = groups.get(name);
      g.decks.push(d);
      g.colors.set(ck, (g.colors.get(ck) || 0) + 1);
    });
    const total = decks.length;
    const arr = [];
    for(const g of groups.values()){
      const n = g.decks.length;
      const share = total ? Math.round(n / total * 1000) / 10 : 0;
      if(n < 2 && share < 0.5) continue;
      const colorsMode = [...g.colors.entries()].sort((a, b)=>b[1] - a[1])[0][0];
      // Presence of each card inside this archetype.
      const pres = new Map();
      g.decks.forEach(d=>{ for(const nm of d.main.keys()) pres.set(nm, (pres.get(nm) || 0) + 1); });
      const pA = (nm)=>(pres.get(nm) || 0) / n;
      const pAll = (nm)=>(allPresence.get(nm) || 0) / Math.max(1, total);
      let key = (fo.keys && (fo.keys[g.name] || fo.keys[g.base])) || (ov.keys && (ov.keys[g.name] || ov.keys[g.base])) || null;
      if(key && !pres.has(key)) key = null;   // a hand pick the lists no longer play is stale
      if(!key){
        // The key card: a nonland played in most of this archetype's lists
        // and rarely elsewhere. The cards its own rule names get a nudge --
        // they are what the community says the deck IS.
        const ruleSet = new Set(g.kind === 'rule' ? ruleCards(g.rule._parent || g.rule).concat(g.rule._parent ? ruleCards(g.rule) : []) : []);
        let best = null, bestS = -1;
        for(const [nm] of pres){
          if(!isKnownNonland(nm, colors) || pA(nm) < 0.5) continue;
          const s = pA(nm) - pAll(nm) * 0.9 + (ruleSet.has(nm) ? 0.1 : 0) + artScore(nm, colors) - (STAPLES.has(nm) ? 0.35 : 0);
          if(s > bestS){ bestS = s; best = nm; }
        }
        key = best;
      }
      if(!key){
        for(const [nm] of [...pres.entries()].sort((a, b)=>b[1] - a[1])){ if(!isLandName(nm, colors)){ key = nm; break; } }
      }
      if(!key){
        const cands = g.kind === 'rule' ? ruleCards(g.rule) : [];
        key = cands[0] || [...pres.entries()].sort((a, b)=>b[1] - a[1])[0][0];
      }
      const rep = g.decks.slice().sort((a, b)=>finishScore(b.result, b.size) - finishScore(a.result, a.size) || String(b.date).localeCompare(String(a.date)))[0];
      const list = (m)=>[...m.entries()].sort((a, b)=>b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([nm, c])=>[c, nm]);
      const style = (fo.styles && (fo.styles[g.name] || fo.styles[g.base])) || (ov.styles && (ov.styles[g.name] || ov.styles[g.base])) || styleOf(g.base);
      const wins = g.decks.filter(d=>/^1st\s+Place/i.test(d.result)).length;
      arr.push({
        name: g.name, style, colors: colorsMode, n, share, wins, key,
        main: list(rep.main), side: list(rep.side),
        event: { name: rep.event, date: rep.date, player: rep.player, result: rep.result, url: rep.url }
      });
    }
    arr.sort((a, b)=>b.n - a.n || a.name.localeCompare(b.name));
    out.formats[fmt] = { decks: total, unknown, archetypes: arr.slice(0, 40) };
  }
  return out;
}

/* ------------------------------------------------------------------ CLI */
if(import.meta.url === 'file://' + process.argv[1] || process.argv[1] && process.argv[1].endsWith('build-meta.mjs')){
  let overrides = {};
  const ovPath = path.join(HERE, 'meta-overrides.json');
  if(fs.existsSync(ovPath)) overrides = looseJson(fs.readFileSync(ovPath, 'utf8'));
  const types = loadTypes(args.cards || '');
  if(types) console.log('card types from ' + args.cards + ': ' + types.size);
  const meta = buildMeta({ cacheDir: CACHE, rulesDir: RULES, days: DAYS, overrides, types });
  let total = 0;
  for(const [f, v] of Object.entries(meta.formats)){
    total += v.decks;
    console.log(`${FORMATS[f].padEnd(9)} ${String(v.decks).padStart(5)} decks, ${String(v.archetypes.length).padStart(2)} archetypes, ${v.unknown} unnamed`);
  }
  // Ratchet: a build that suddenly sees almost nothing is a broken checkout,
  // not a dead format. Keep last week's file rather than publish emptiness.
  if(total < 200){
    console.error(`Only ${total} decks in ${meta.from}..${meta.to} -- keeping the previous ${OUT}.`);
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }
  // Stable output: without real changes the file is byte-identical, so the
  // robot commits nothing.
  const prev = fs.existsSync(OUT) ? (()=>{ try{ return JSON.parse(fs.readFileSync(OUT, 'utf8')); }catch(e){ return null; } })() : null;
  if(prev && JSON.stringify(Object.assign({}, prev, { built: '' })) === JSON.stringify(Object.assign({}, meta, { built: '' }))){
    console.log('No change in the metagame -- ' + OUT + ' left as it is.');
    process.exit(0);
  }
  fs.writeFileSync(OUT, JSON.stringify(meta));
  console.log(`Wrote ${OUT}: ${meta.from}..${meta.to}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}
