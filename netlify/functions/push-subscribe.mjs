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
  await store.setJSON(key, { sub: body, t: Date.now() });
  return Response.json({ ok: true }, { headers: cors });
};
