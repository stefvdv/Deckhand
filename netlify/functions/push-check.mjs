/* Daily push check (Netlify scheduled function, Functions 2.0/ESM).
   Two triggers to notify about, one run:
   1. A NEW upcoming Magic set on Scryfall  → "new spoilers" push.
   2. A NEW Deckhand version (version.json) → "app updated" push with the
      changelog bullets (NL — the crew is Dutch).
   State and subscriptions live in Netlify Blobs; dead subscriptions
   (404/410) are pruned. Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
   optional VAPID_SUBJECT. */
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

async function pushToAll(payload){
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
  return { sent, pruned };
}

export default async () => {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if(!pub || !priv) return new Response('VAPID env vars missing', { status: 500 });
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:deckhand@example.com', pub, priv);
  const state = getStore('push-state');
  const report = [];

  // ---- 1. New sets on Scryfall ----
  try{
    const res = await fetch('https://api.scryfall.com/sets');
    if(res.ok){
      const sets = (await res.json()).data || [];
      const now = Date.now(), soon = now + 45 * 24 * 3600 * 1000;
      const KINDS = new Set(['expansion','commander','masters','draft_innovation','core']);
      const interesting = sets.filter(s => {
        if(!KINDS.has(s.set_type) || s.digital) return false;
        const t = Date.parse(s.released_at || '');
        return t && t > now - 3 * 24 * 3600 * 1000 && t < soon;
      });
      const seen = (await state.get('announced', { type: 'json' })) || [];
      const fresh = interesting.filter(s => !seen.includes(s.code));
      if(fresh.length){
        const names = fresh.map(s => s.name).slice(0, 3).join(', ');
        const r = await pushToAll(JSON.stringify({
          title: '🔮 Nieuwe Magic-set gespot',
          body: names + ' — de spoilers verzamelen zich in Deckhand.',
          url: './?go=spoilers'
        }));
        await state.setJSON('announced', seen.concat(fresh.map(s => s.code)).slice(-300));
        report.push(`sets: ${names} → sent ${r.sent}, pruned ${r.pruned}`);
      } else report.push('sets: nothing new');
    }
  }catch(e){ report.push('sets check failed: ' + (e && e.message)); }

  // ---- 2. New Deckhand release (version.json next to index.html) ----
  try{
    const base = process.env.URL || 'https://deckhandcompanion.netlify.app';
    const res = await fetch(base + '/version.json', { cache: 'no-store' });
    if(res.ok){
      const v = await res.json();
      const last = await state.get('lastVersion', { type: 'json' });
      if(!last){
        await state.setJSON('lastVersion', { version: v.version });   // first run: remember, never spam
        report.push('version: baseline ' + v.version);
      } else if(last.version !== v.version){
        const bullets = ((v.notes && v.notes.nl) || []).slice(0, 3).map(x => '• ' + x).join('\n');
        const r = await pushToAll(JSON.stringify({
          title: '⚓ Deckhand bijgewerkt — v' + v.version,
          body: bullets || 'Open de app voor de details.',
          url: './'
        }));
        await state.setJSON('lastVersion', { version: v.version });
        report.push(`version: ${last.version} → ${v.version}, sent ${r.sent}, pruned ${r.pruned}`);
      } else report.push('version: unchanged ' + v.version);
    }
  }catch(e){ report.push('version check failed: ' + (e && e.message)); }

  return new Response(report.join(' | '));
};

export const config = { schedule: '30 8 * * *' };   // daily, 08:30 UTC (~10:30 NL)
