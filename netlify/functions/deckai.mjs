/* Deckhand deck advisor (1.13) — Netlify Functions 2.0 (ESM).

   Two questions about ONE deck, answered by the same free AI services as the
   rules judge (Groq first, then Cerebras):
   - kind "cuts":  the deck holds too many cards. The app sends the leader(s),
     the chosen Theme / Kindred, the deck's numbers (roles, curve, lands) and
     every card that may go, with its Oracle text. The AI reads how the cards
     work TOGETHER and returns the weakest ones for this deck's plan, each
     with a reason.
   - kind "lands": the app sends the deck's mana needs (coloured pips per
     colour, curve, ramp), the lands already in it and a list of lands that
     fit (legal, in colour, ranked by EDHREC for this commander). The AI
     returns a land count, the best lands from THAT list and lands in the
     deck that are worth swapping out.

   The AI may only name cards from the lists it was given: anything else is
   dropped here, so a made-up card never reaches the app.

   Guards, like the judge (a public endpoint is a free AI for anyone):
   - size limits on everything that comes in;
   - DECKAI_DAILY (default 10) analyses per device per day, DECKAI_GLOBAL
     (default 200) for the whole app per day -- counted apart from the judge,
     so analyses never eat the rules questions;
   - the same deck asked again is served from the cache, free. */
import crypto from 'node:crypto';

const MAX_CANDS = 90, MAX_ORACLE = 260, MAX_TOTAL_CHARS = 26000, MAX_DECK_NAMES = 110;
const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
const CEREBRAS_MODELS = ['gpt-oss-120b', 'llama-3.3-70b'];

const s = (x, n)=>String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (x, lo, hi, def)=>{ const v = Number(x); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };

export function clean(body){
  body = body || {};
  const kind = body.kind === 'lands' ? 'lands' : 'cuts';
  const lang = body.lang === 'nl' ? 'nl' : 'en';
  const dk = body.deck || {};
  const fmt = ['commander', 'admiral', 'paupercommander', 'predh', 'duel'].includes(dk.format) ? dk.format : 'commander';
  const leaders = (Array.isArray(dk.leaders) ? dk.leaders : []).slice(0, 2).map(c=>({
    name: s(c && c.name, 150), type: s(c && c.type, 150), oracle: s(c && c.oracle, 900),
    cost: s(c && c.cost, 60), colors: String(c && c.colors || '').toUpperCase().replace(/[^WUBRG]/g, '').slice(0, 5)
  })).filter(c=>c.name);
  const pick = (o, keys, hi)=>{ const r = {}; keys.forEach(k=>{ r[k] = num(o && o[k], 0, hi, 0); }); return r; };
  const deck = {
    format: fmt, leaders, name: s(dk.name, 60),
    theme: s(dk.theme, 60), kindred: s(dk.kindred, 60),
    size: num(dk.size, 0, 300, 0), limit: num(dk.limit, 0, 300, 100),
    over: num(dk.over, 0, 60, 0),
    landCount: num(dk.landCount, 0, 80, 0), landGoal: num(dk.landGoal, 0, 60, 0),
    avgMv: num(dk.avgMv, 0, 16, 0),
    roles: pick(dk.roles, ['ramp', 'draw', 'removal', 'wipe'], 99),
    guide: pick(dk.guide, ['land', 'ramp', 'draw', 'removal', 'wipe'], 99),
    curve: (Array.isArray(dk.curve) ? dk.curve : []).slice(0, 8).map(x=>num(x, 0, 99, 0)),
    pips: pick(dk.pips, ['W', 'U', 'B', 'R', 'G'], 400),
    sources: pick(dk.sources, ['W', 'U', 'B', 'R', 'G'], 99),
    colors: String(dk.colors || '').toUpperCase().replace(/[^WUBRG]/g, '').slice(0, 5),
    others: (Array.isArray(dk.others) ? dk.others : []).slice(0, MAX_DECK_NAMES).map(x=>s(x, 120)).filter(Boolean)
  };
  let room = MAX_TOTAL_CHARS;
  const cands = [], seen = new Set();
  for(const c of (Array.isArray(body.cands) ? body.cands : []).slice(0, MAX_CANDS)){
    const name = s(c && c.name, 150);
    if(!name || seen.has(name.toLowerCase())) continue;
    const k = { name, type: s(c && c.type, 120), mv: num(c && c.mv, 0, 20, 0), cost: s(c && c.cost, 40), oracle: s(c && c.oracle, MAX_ORACLE),
      note: s(c && c.note, 100), inDeck: !!(c && c.inDeck) };
    const len = k.name.length + k.type.length + k.cost.length + k.oracle.length + k.note.length + 20;
    if(len > room) break;
    room -= len;
    seen.add(name.toLowerCase());
    cands.push(k);
  }
  const want = num(body.want, 1, 15, kind === 'cuts' ? Math.min(12, deck.over + 3) : 10);
  return { kind, lang, deck, cands, want };
}

const FMT_TXT = {
  commander: 'Commander (100-card singleton, 40 life, a legendary commander; decks usually run 33-38 lands).',
  paupercommander: 'Pauper Commander (100-card singleton of commons led by an uncommon creature, 30 life).',
  predh: 'PreDH (Commander with cards up to 2011).',
  duel: 'Duel Commander (1-versus-1 Commander, 20 life, faster games).',
  admiral: 'Admiral, a house format: exactly 60 cards including the leader (the "Admiral"), singleton, NO lands in the deck (players share a Landing Zone of basics), 30 life. Never suggest lands for it.'
};

export function systemPrompt(c){
  const nl = c.lang === 'nl';
  const common = [
    'You are an expert Magic: The Gathering deckbuilder helping a player improve ONE deck.',
    'Format: ' + FMT_TXT[c.deck.format],
    'Base every judgement on the Oracle texts given: how each card works with the leader, the chosen theme and the other cards. Synergy and the deck\'s game plan matter more than raw card power or popularity.',
    'You may ONLY name cards that appear in the CANDIDATES list, spelled exactly as listed. Never invent cards.',
    nl ? 'Write all reasons and the summary in Dutch (simple words, like talking to a friend at the table). Keep card names in English.'
       : 'Write in plain English, like talking to a friend at the table.',
    'Each reason: one sentence, at most 25 words, concrete (name the card or mechanic it clashes with or duplicates).'
  ];
  if(c.kind === 'cuts') return common.concat([
    `TASK: the deck has ${c.deck.over} card(s) too many. Pick the ${c.want} candidates that contribute LEAST to this deck's plan, weakest first.`,
    'Work in three steps, in this order:',
    '1. ENGINE. Read the leader\'s text literally AND broadly. Name the resource it uses or rewards and every way the deck can make that resource. General words are general: "a counter" means ANY counter (+1/+1, shield, lore, time, charge on a creature, keyword counters such as flying or deathtouch counters); "a spell" means any spell; "a creature you control" includes tokens. Note the leader\'s colours and creature types: cards that check them (for example "if enchanted creature is white") work on this leader when it has them.',
    '2. CORE. List the candidates that make, move, double or pay off that resource, protect the leader when the deck relies on it, or carry the chosen theme. These stay, even when they look weak or narrow on their own.',
    '3. CUTS. Only from the candidates NOT in your core list. Good reasons: does nothing for the engine, the leader or the theme; another card in the deck does the same job better (name that card); too expensive for what it does here; win-more; a condition this deck rarely meets.',
    'Before you write a reason, check it against the leader\'s text, colours and types and against the rest of the deck. Never call a card useless for a reason the leader\'s own text contradicts.',
    'Lands are only candidates when they are listed. Notes such as "in 40% of decks" are popularity; use them only as a tie-breaker.',
    'Reply with ONE JSON object and nothing else, keys in this order:',
    '{"engine": "one or two sentences: what the leader does and how this deck feeds it", "core": ["exact candidate names"], "plan": "one sentence for the player: what this deck is trying to do", "cuts": [{"name": "exact candidate name", "why": "reason"}]}'
  ]).join('\n');
  return common.concat([
    'TASK: advise on the mana base. Decide how many lands this deck should run in total, given its curve, ramp count and colour needs.',
    `Then pick up to ${c.want} lands from the CANDIDATES marked [new] that would help this deck most (colour fixing for its heaviest colours, few enters-tapped lands, utility that fits the plan), best first.`,
    'Also name up to 4 lands marked [in deck] that are worth swapping out (wrong colours, too many tapped lands, no use for this plan). An empty list is fine.',
    'Reply with ONE JSON object and nothing else:',
    '{"count": 36, "countWhy": "reason for the land count", "plan": "one sentence about the colour needs", "add": [{"name": "exact candidate name", "why": "reason"}], "swap": [{"name": "exact candidate name", "why": "reason"}]}'
  ]).join('\n');
}

export function userMessage(c){
  const d = c.deck;
  const L = [];
  L.push('LEADER(S):');
  const COL = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
  d.leaders.forEach(k=>L.push(`${k.name}${k.cost ? ' ' + k.cost : ''} — ${k.type} — colours: ${k.colors ? k.colors.split('').map(x=>COL[x]).join(', ') : 'colourless'}\n${k.oracle}`));
  if(d.name) L.push('', 'DECK NAME (the player\'s own words, may hint at the plan): ' + d.name);
  if(d.theme || d.kindred) L.push('', 'CHOSEN PLAN: ' + [d.kindred && ('Kindred ' + d.kindred), d.theme && ('Theme ' + d.theme)].filter(Boolean).join(' + '));
  L.push('', 'DECK NUMBERS:');
  L.push(`cards ${d.size} of ${d.limit}` + (d.over ? ` (${d.over} too many)` : ''));
  if(d.format !== 'admiral') L.push(`lands ${d.landCount}` + (d.landGoal ? ` (player's goal ${d.landGoal})` : ''));
  L.push(`roles: ramp ${d.roles.ramp}, card draw ${d.roles.draw}, removal ${d.roles.removal}, board wipes ${d.roles.wipe}` +
    ` (common guide: ${d.format === 'admiral' ? '' : 'lands ' + d.guide.land + ', '}ramp ${d.guide.ramp}, draw ${d.guide.draw}, removal ${d.guide.removal}, wipes ${d.guide.wipe})`);
  if(d.curve.length) L.push('curve (nonland cards at mana value 0,1,2,3,4,5,6,7+): ' + d.curve.join(', ') + (d.avgMv ? ` — average ${d.avgMv}` : ''));
  if(c.kind === 'lands'){
    L.push('colour identity: ' + (d.colors || 'colourless'));
    L.push('coloured mana symbols in the nonland cards: ' + ['W', 'U', 'B', 'R', 'G'].map(k=>k + ' ' + d.pips[k]).join(', '));
    L.push('lands in the deck that make each colour: ' + ['W', 'U', 'B', 'R', 'G'].map(k=>k + ' ' + d.sources[k]).join(', '));
  }
  if(d.others.length) L.push('', 'THE REST OF THE DECK (names only):', d.others.join('; '));
  L.push('', 'CANDIDATES:');
  c.cands.forEach(k=>{
    const tag = c.kind === 'lands' ? (k.inDeck ? '[in deck] ' : '[new] ') : '';
    L.push(`- ${tag}${k.name}${k.cost ? ' ' + k.cost : (k.mv ? ' | MV ' + k.mv : '')} | ${k.type}${k.note ? ' | ' + k.note : ''}\n  ${k.oracle}`);
  });
  return L.join('\n');
}

/* The model's reply -> our shape: only listed names, each once. */
export function parseReply(text, c){
  let o = null;
  try{ o = JSON.parse(text); }catch(e){
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if(m){ try{ o = JSON.parse(m[0]); }catch(e2){ o = null; } }
  }
  if(!o || typeof o !== 'object') return null;
  const byName = new Map();
  c.cands.forEach(k=>{
    byName.set(k.name.toLowerCase(), k);
    byName.set(k.name.split(' // ')[0].toLowerCase(), k);
  });
  const used = new Set();
  const list = (arr, max, ok)=>(Array.isArray(arr) ? arr : []).map(x=>{
    const nm = String(x && (x.name || x.card) || (typeof x === 'string' ? x : '')).trim().replace(/^\[(?:new|in deck)\]\s*/i, '');
    const k = byName.get(nm.toLowerCase());
    if(!k || used.has(k.name) || (ok && !ok(k))) return null;
    used.add(k.name);
    return { name: k.name, why: s(x && (x.why || x.reason), 300) };
  }).filter(Boolean).slice(0, max);
  const plan = s(o.plan, 300);
  if(c.kind === 'cuts'){
    // the AI's own core list wins over a cut that contradicts it
    const core = new Set((Array.isArray(o.core) ? o.core : []).map(x=>byName.get(String(x && (x.name || x) || '').trim().toLowerCase())).filter(Boolean).map(k=>k.name));
    const cuts = list(o.cuts, 15, k=>!core.has(k.name));
    if(!cuts.length) return null;
    return { kind: 'cuts', plan, engine: s(o.engine, 400), core: Array.from(core).slice(0, 40), cuts };
  }
  const count = Math.round(num(o.count, 0, 60, 0));
  const add = list(o.add, 15, k=>!k.inDeck);
  const swap = list(o.swap, 4, k=>k.inDeck);
  if(!count && !add.length) return null;
  return { kind: 'lands', plan, count: count >= 20 && count <= 45 ? count : 0, countWhy: s(o.countWhy, 300), add, swap };
}

async function chat(fetchImpl, url, key, model, sys, user, extras = true){
  const req = { model, temperature: 0.2, max_tokens: 3500,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  if(extras){
    req.response_format = { type: 'json_object' };
    if(/gpt-oss/.test(model)) req.reasoning_effort = 'medium';
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(req)
  });
  // a model that refuses JSON mode or the effort setting: once more without them
  if(res.status === 400 && extras) return chat(fetchImpl, url, key, model, sys, user, false);
  if(!res.ok){ const e = new Error('http ' + res.status); e.status = res.status; throw e; }
  const j = await res.json();
  return j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
}

export async function askProviders(env, fetchImpl, c){
  const prov = [];
  if(env.GROQ_API_KEY) prov.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY, models: env.GROQ_MODEL ? [env.GROQ_MODEL] : GROQ_MODELS });
  if(env.CEREBRAS_API_KEY) prov.push({ name: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: env.CEREBRAS_API_KEY, models: env.CEREBRAS_MODEL ? [env.CEREBRAS_MODEL] : CEREBRAS_MODELS });
  if(!prov.length) return { error: 'nokey' };
  // 1.14: quality first -- the strong model on each provider, then the
  // smaller one: [groq gpt-oss, cerebras gpt-oss, groq llama, cerebras llama]
  const lanes = [];
  const rounds = Math.max(...prov.map(p=>p.models.length));
  for(let i = 0; i < rounds; i++) prov.forEach(p=>{ if(p.models[i]) lanes.push({ name: p.name, url: p.url, key: p.key, models: [p.models[i]] }); });
  const sys = systemPrompt(c), user = userMessage(c);
  let last = 'down';
  const t0 = Date.now();
  for(const ln of lanes) for(const m of ln.models){
    // Netlify stops a function after 60 s: no new attempt after 35 s
    if(Date.now() - t0 > 35000) return { error: last };
    try{
      const out = parseReply(await chat(fetchImpl, ln.url, ln.key, m, sys, user), c);
      if(out) return Object.assign(out, { provider: ln.name, model: m });
      last = 'shape';
    }catch(e){
      // a 429 here is often the per-minute token cap of ONE model: try the next model
      last = e && (e.status === 429 || e.status === 413) ? 'quota' : 'down';
    }
  }
  return { error: last };
}

const today = ()=>new Date().toISOString().slice(0, 10);
const sha = (x)=>crypto.createHash('sha256').update(x).digest('hex');

/* Testable core: deps = { env, fetch, store(name) -> {get(key,{type}), setJSON(key,val)} | null, ip } */
export async function handle(body, deps){
  const env = deps.env || {};
  const c = clean(body);
  if(!c.deck.leaders.length || c.cands.length < 2) return { status: 400, json: { ok: false, error: 'empty' } };
  if(c.kind === 'lands' && c.deck.format === 'admiral') return { status: 400, json: { ok: false, error: 'nolands' } };
  const dev = sha(String(body && body.device || '') + '|' + (deps.ip || '')).slice(0, 24);
  const cacheKey = sha(JSON.stringify(['d2', c.kind, c.lang, c.want, c.deck.format, c.deck.leaders.map(k=>k.name), c.deck.theme, c.deck.kindred,
    c.deck.landGoal, c.deck.over, c.deck.others.slice().sort(), c.cands.map(k=>k.name + (k.inDeck ? '*' : '')).sort()]));
  const cache = deps.store ? deps.store('deckai-cache') : null;
  const count = deps.store ? deps.store('deckai-count') : null;
  try{
    const hit = cache && await cache.get(cacheKey, { type: 'json' });
    if(hit && hit.kind) return { status: 200, json: Object.assign({ ok: true, cached: true }, hit) };
  }catch(e){}
  const day = today(), perDev = +env.DECKAI_DAILY || 10, all = +env.DECKAI_GLOBAL || 200;
  let devN = 0, allN = 0;
  try{
    if(count){
      devN = ((await count.get('d|' + day + '|' + dev, { type: 'json' })) || {}).n || 0;
      allN = ((await count.get('g|' + day, { type: 'json' })) || {}).n || 0;
    }
  }catch(e){}
  if(devN >= perDev) return { status: 429, json: { ok: false, error: 'limit', limit: perDev } };
  if(allN >= all) return { status: 429, json: { ok: false, error: 'quota' } };
  const out = await askProviders(env, deps.fetch, c);
  if(out.error) return { status: out.error === 'nokey' ? 503 : 502, json: { ok: false, error: out.error } };
  try{
    if(count){
      await count.setJSON('d|' + day + '|' + dev, { n: devN + 1 });
      await count.setJSON('g|' + day, { n: allN + 1 });
    }
    if(cache) await cache.setJSON(cacheKey, Object.assign({ t: Date.now() }, out));
  }catch(e){}
  return { status: 200, json: Object.assign({ ok: true, cached: false, left: Math.max(0, perDev - devN - 1) }, out) };
}

export default async (req, context) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
  if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if(req.method !== 'POST') return new Response('POST', { status: 405, headers: cors });
  let body = {};
  try{ body = await req.json(); }catch(e){ return Response.json({ ok: false, error: 'json' }, { status: 400, headers: cors }); }
  let storeFn = null;
  try{ const { getStore } = await import('@netlify/blobs'); storeFn = (n)=>getStore(n); }catch(e){ storeFn = null; }
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || '';
  const r = await handle(body, { env: process.env, fetch: globalThis.fetch, store: storeFn, ip });
  return Response.json(r.json, { status: r.status, headers: cors });
};
