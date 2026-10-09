/* Deckhand rules judge (1.33) — Netlify Functions 2.0 (ESM).

   The app sends: the question, the cards tagged with @ (oracle text and
   official rulings, from the phone's own card database) and the Comprehensive
   Rules that its local search found for the question. This function asks a
   free AI service to answer from THAT material only, and returns
     { ok, answer, reasoning, cites: ["603.2", ...], confident, provider, cached }.

   Free first: Groq (GROQ_API_KEY), then Cerebras (CEREBRAS_API_KEY) if that
   key is also set. No credit card on those accounts = no bill, ever; when
   the free quota is used up the app falls back to its own rule search.

   Guards, because a public endpoint is a free AI for anyone who finds it:
   - size limits on everything that comes in;
   - JUDGE_DAILY (default 20) questions per device per day, and
     JUDGE_GLOBAL (default 800) for the whole app per day (Netlify Blobs);
   - the same question about the same cards comes from the cache, free.
   The rules text and system prompt live HERE, so a caller cannot change
   the instructions. */
import crypto from 'node:crypto';

const MAX_Q = 500, MAX_CARDS = 5, MAX_RULES = 40, MAX_RULE_CHARS = 18000, MAX_CARD_CHARS = 2500;

const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
const CEREBRAS_MODELS = ['gpt-oss-120b', 'llama-3.3-70b'];

export function systemPrompt(lang){
  const nl = lang === 'nl';
  return [
    'You are a certified Magic: The Gathering rules judge answering a player at the table.',
    'Use ONLY the Comprehensive Rules excerpts and card texts/rulings given in the user message. Do not rely on memory of other rules or cards.',
    'Card texts are the official Oracle text. Official rulings for a card outrank your own reading.',
    'Cite the rule numbers you rely on (for example 603.2 or 702.19b). Only cite numbers that appear in the excerpts.',
    'If the excerpts do not settle the question, say so plainly, give your best reading and set "confident" to false.',
    nl ? 'Write the answer and reasoning in Dutch. Keep card names, rule numbers and quoted rule text in English.'
       : 'Write in English.',
    'Reply with ONE JSON object and nothing else:',
    '{"answer": "one or two sentences, starting with Yes, No, or the direct outcome",',
    ' "reasoning": "a short explanation, at most 150 words, quoting the key rule words",',
    ' "cites": ["rule numbers used"], "confident": true}'
  ].join('\n');
}

export function clean(body){
  const q = String(body && body.q || '').trim().slice(0, MAX_Q);
  const lang = body && body.lang === 'nl' ? 'nl' : 'en';
  const cards = (Array.isArray(body && body.cards) ? body.cards : []).slice(0, MAX_CARDS).map(c=>({
    name: String(c && c.name || '').slice(0, 150),
    type: String(c && c.type || '').slice(0, 150),
    oracle: String(c && c.oracle || '').slice(0, 1500),
    rulings: (Array.isArray(c && c.rulings) ? c.rulings : []).slice(0, 12).map(r=>String(r || '').slice(0, 400))
  })).filter(c=>c.name);
  let room = MAX_RULE_CHARS;
  const rules = [];
  for(const r of (Array.isArray(body && body.rules) ? body.rules : []).slice(0, MAX_RULES)){
    const n = String(r && r.n || '').trim(), t = String(r && r.t || '').trim();
    if(!/^\d{3}(\.\d+[a-z]?)?$/.test(n) || !t) continue;
    if(t.length > room) break;
    room -= t.length;
    rules.push({ n, t });
  }
  return { q, lang, cards, rules };
}

export function userMessage(c){
  let cardTxt = c.cards.map(k=>{
    let s = `${k.name}${k.type ? ' — ' + k.type : ''}\n${k.oracle}`;
    if(k.rulings.length) s += '\nOfficial rulings:\n' + k.rulings.map(r=>'- ' + r).join('\n');
    return s;
  }).join('\n\n');
  if(cardTxt.length > MAX_CARD_CHARS * MAX_CARDS) cardTxt = cardTxt.slice(0, MAX_CARD_CHARS * MAX_CARDS);
  return [
    'QUESTION:', c.q, '',
    'CARDS:', cardTxt || '(none tagged)', '',
    'COMPREHENSIVE RULES EXCERPTS:', c.rules.map(r=>r.n + ' ' + r.t).join('\n')
  ].join('\n');
}

/* The model's reply -> our shape. Tolerates prose around the JSON. */
export function parseReply(text){
  let o = null;
  try{ o = JSON.parse(text); }catch(e){
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if(m){ try{ o = JSON.parse(m[0]); }catch(e2){ o = null; } }
  }
  if(!o || typeof o.answer !== 'string' || !o.answer.trim()) return null;
  const cites = Array.from(new Set((Array.isArray(o.cites) ? o.cites : [])
    .map(x=>String(x).trim().replace(/^(CR|rule)\s*/i, '').replace(/\.$/, ''))
    .filter(x=>/^\d{3}(\.\d+[a-z]?)?$/.test(x)))).slice(0, 12);
  return { answer: o.answer.trim().slice(0, 600), reasoning: String(o.reasoning || '').trim().slice(0, 2000), cites, confident: o.confident !== false };
}

async function chat(fetchImpl, url, key, model, sys, user, jsonMode = true){
  const req = { model, temperature: 0.1, max_tokens: 1200,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  if(jsonMode) req.response_format = { type: 'json_object' };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(req)
  });
  // a model that does not do JSON mode: once more without it (the prompt asks for JSON anyway)
  if(res.status === 400 && jsonMode) return chat(fetchImpl, url, key, model, sys, user, false);
  if(!res.ok){ const e = new Error('http ' + res.status); e.status = res.status; throw e; }
  const j = await res.json();
  return j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
}

/* Each provider, each model in turn, until one answers in shape. */
export async function askProviders(env, fetchImpl, sys, user){
  const lanes = [];
  if(env.GROQ_API_KEY) lanes.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY, models: env.GROQ_MODEL ? [env.GROQ_MODEL] : GROQ_MODELS });
  if(env.CEREBRAS_API_KEY) lanes.push({ name: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: env.CEREBRAS_API_KEY, models: env.CEREBRAS_MODEL ? [env.CEREBRAS_MODEL] : CEREBRAS_MODELS });
  if(!lanes.length) return { error: 'nokey' };
  let last = 'down';
  for(const ln of lanes) for(const m of ln.models){
    try{
      const out = parseReply(await chat(fetchImpl, ln.url, ln.key, m, sys, user));
      if(out) return Object.assign(out, { provider: ln.name });
      last = 'shape';
    }catch(e){
      last = e && e.status === 429 ? 'quota' : 'down';
      if(e && e.status === 429) break;          // this provider is out for today: next provider
    }
  }
  return { error: last };
}

const today = ()=>new Date().toISOString().slice(0, 10);
const sha = (s)=>crypto.createHash('sha256').update(s).digest('hex');

/* Testable core: deps = { env, fetch, store(name) -> {get(key,{type}), setJSON(key,val)} | null, ip } */
export async function handle(body, deps){
  const env = deps.env || {};
  const c = clean(body);
  if(c.q.length < 4) return { status: 400, json: { ok: false, error: 'empty' } };
  const dev = sha(String(body && body.device || '') + '|' + (deps.ip || '')).slice(0, 24);
  const cacheKey = sha(JSON.stringify([c.lang, c.q.toLowerCase().replace(/\s+/g, ' '), c.cards.map(k=>k.name.toLowerCase()).sort()]));
  const cache = deps.store ? deps.store('judge-cache') : null;
  const count = deps.store ? deps.store('judge-count') : null;
  // 1. asked before: free and instant
  try{
    const hit = cache && await cache.get(cacheKey, { type: 'json' });
    if(hit && hit.answer) return { status: 200, json: Object.assign({ ok: true, cached: true }, hit) };
  }catch(e){}
  // 2. limits
  const day = today(), perDev = +env.JUDGE_DAILY || 20, all = +env.JUDGE_GLOBAL || 800;
  let devN = 0, allN = 0;
  try{
    if(count){
      devN = ((await count.get('d|' + day + '|' + dev, { type: 'json' })) || {}).n || 0;
      allN = ((await count.get('g|' + day, { type: 'json' })) || {}).n || 0;
    }
  }catch(e){}
  if(devN >= perDev) return { status: 429, json: { ok: false, error: 'limit', limit: perDev } };
  if(allN >= all) return { status: 429, json: { ok: false, error: 'quota' } };
  // 3. ask
  const out = await askProviders(env, deps.fetch, systemPrompt(c.lang), userMessage(c));
  if(out.error) return { status: out.error === 'nokey' ? 503 : 502, json: { ok: false, error: out.error } };
  try{
    if(count){
      await count.setJSON('d|' + day + '|' + dev, { n: devN + 1 });
      await count.setJSON('g|' + day, { n: allN + 1 });
    }
    if(cache) await cache.setJSON(cacheKey, { answer: out.answer, reasoning: out.reasoning, cites: out.cites, confident: out.confident, provider: out.provider, t: Date.now() });
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
