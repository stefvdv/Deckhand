/* Daily spoiler check → Web Push to every subscription.
   Runs on Netlify's scheduler (see exports.config). Compares Scryfall's set
   list against the codes we've already announced (Netlify Blobs 'push-state');
   any NEW upcoming/just-released set triggers one push. Dead subscriptions
   (410/404) are pruned. Env vars required: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
   optional VAPID_SUBJECT (mailto:you@example.com). */
const webpush = require('web-push');
const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if(!pub || !priv) return { statusCode: 500, body: 'VAPID env vars missing' };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:deckhand@example.com', pub, priv);

  const res = await fetch('https://api.scryfall.com/sets');
  if(!res.ok) return { statusCode: 502, body: 'scryfall ' + res.status };
  const sets = (await res.json()).data || [];
  const now = Date.now(), soon = now + 45 * 24 * 3600 * 1000;
  // Sets people care about: real expansions/commander/masters/draft products
  // that are upcoming (within 45 days) or released in the last 3 days.
  const KINDS = new Set(['expansion','commander','masters','draft_innovation','core']);
  const interesting = sets.filter(s => {
    if(!KINDS.has(s.set_type) || s.digital) return false;
    const t = Date.parse(s.released_at || '');
    return t && t > now - 3 * 24 * 3600 * 1000 && t < soon;
  });

  const stateStore = getStore('push-state');
  const seen = (await stateStore.get('announced', { type: 'json' })) || [];
  const fresh = interesting.filter(s => !seen.includes(s.code));
  if(!fresh.length) return { statusCode: 200, body: 'nothing new' };

  const names = fresh.map(s => s.name).slice(0, 3).join(', ');
  const payload = JSON.stringify({
    title: '🔮 New Magic set spotted',
    body: names + ' — spoilers are gathering in Deckhand.',
    url: './?go=spoilers'
  });

  const subsStore = getStore('push-subs');
  let sent = 0, pruned = 0;
  const { blobs } = await subsStore.list();
  for(const b of blobs || []){
    const rec = await subsStore.get(b.key, { type: 'json' });
    if(!rec || !rec.sub) continue;
    try{ await webpush.sendNotification(rec.sub, payload); sent++; }
    catch(e){
      const code = e && e.statusCode;
      if(code === 404 || code === 410){ await subsStore.delete(b.key); pruned++; }
    }
  }
  await stateStore.setJSON('announced', seen.concat(fresh.map(s => s.code)).slice(-300));
  return { statusCode: 200, body: `sent ${sent}, pruned ${pruned}, new: ${names}` };
};

exports.config = { schedule: '30 8 * * *' };   // daily, 08:30 UTC
