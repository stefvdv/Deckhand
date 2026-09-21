/* Deckhand push subscriptions — stored in Netlify Blobs.
   POST  body = PushSubscription JSON  → saved (key = hash of endpoint)
   DELETE body = { endpoint }          → removed */
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' };
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  let body = {};
  try{ body = JSON.parse(event.body || '{}'); }catch(e){ return { statusCode: 400, headers: cors, body: 'bad json' }; }
  if(!body.endpoint) return { statusCode: 400, headers: cors, body: 'endpoint required' };
  const store = getStore('push-subs');
  const key = crypto.createHash('sha256').update(body.endpoint).digest('hex');
  if(event.httpMethod === 'DELETE'){
    await store.delete(key);
    return { statusCode: 200, headers: cors, body: '{"ok":true,"removed":true}' };
  }
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'POST or DELETE' };
  if(!body.keys || !body.keys.p256dh || !body.keys.auth) return { statusCode: 400, headers: cors, body: 'keys required' };
  await store.setJSON(key, { sub: body, t: Date.now() });
  return { statusCode: 200, headers: cors, body: '{"ok":true}' };
};
