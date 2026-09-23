/* Deckhand push subscriptions — Netlify Functions 2.0 (ESM), where Netlify
   Blobs configures itself. POST body = PushSubscription → saved;
   DELETE body = { endpoint } → removed. */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

export default async (req) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' };
  if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let body = {};
  try{ body = await req.json(); }catch(e){ return new Response('bad json', { status: 400, headers: cors }); }
  if(!body.endpoint) return new Response('endpoint required', { status: 400, headers: cors });
  const store = getStore('push-subs');
  const key = crypto.createHash('sha256').update(body.endpoint).digest('hex');
  if(req.method === 'DELETE'){
    await store.delete(key);
    return Response.json({ ok: true, removed: true }, { headers: cors });
  }
  if(req.method !== 'POST') return new Response('POST or DELETE', { status: 405, headers: cors });
  if(!body.keys || !body.keys.p256dh || !body.keys.auth) return new Response('keys required', { status: 400, headers: cors });
  // Remember the reader's language so the daily check can write to them in it.
  // Subscriptions saved before this existed carry no lang and fall back to Dutch,
  // which is what they have been receiving all along.
  const lang = body.lang === 'en' ? 'en' : (body.lang === 'nl' ? 'nl' : undefined);
  // Two switches now: spoilers and app updates. A record saved before they
  // existed carries neither, and a missing switch counts as ON — those
  // readers signed up for everything and keep getting everything.
  const aan = (v)=>v === undefined ? true : !!v;
  // How often the spoiler lane may speak: every card, every 5, every 10, or
  // never. Anything unrecognised means the old behaviour, every 5. The
  // reader's place in the spoiler count is kept, so changing the setting
  // does not replay everything they already saw.
  const EVERY = [0, 1, 5, 10];
  const gevraagd = parseInt(body.spoilerEvery, 10);
  const every = EVERY.indexOf(gevraagd) > -1 ? gevraagd : (aan(body.spoilers) ? 5 : 0);
  const oud = await store.get(key, { type: 'json' });
  await store.setJSON(key, { sub: { endpoint: body.endpoint, keys: body.keys }, lang,
    spoilers: every > 0, spoilerEvery: every, updates: aan(body.updates),
    spoilerSeq: oud && Number.isFinite(oud.spoilerSeq) ? oud.spoilerSeq : undefined,
    t: Date.now() });
  return Response.json({ ok: true }, { headers: cors });
};
