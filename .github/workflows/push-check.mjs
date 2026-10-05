/* Hourly push check (Netlify scheduled function, Functions 2.0/ESM).
   Three triggers to notify about, one run:
   1. A NEW upcoming Magic set on Scryfall  → "new set" push.
   2. A NEW Deckhand version (version.json) → "app updated" push with the
      changelog bullets.
   3. NEWLY SPOILED CARDS — counted on a running sequence. Every reader
      picks their own pace in Extras (every card, every 5, every 10, or
      never) and is told the moment their own threshold is reached; what
      falls short simply waits for the next round.
   Nothing is ever sent outside 09:00–21:00 Dutch time.
   State and subscriptions live in Netlify Blobs; dead subscriptions
   (404/410) are pruned. Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
   optional VAPID_SUBJECT. */
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

/* No pushes at night. The function wakes every hour; outside the window it
   simply goes back to sleep, so a release at 23:00 is announced at 09:00.
   Dutch clock, not UTC — summer and winter time shift on their own. */
const WINDOW_FROM = 9, WINDOW_TO = 21;
function dutchHour(){
  try{
    return parseInt(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23'
    }).format(new Date()), 10);
  }catch(e){ return (new Date().getUTCHours() + 2) % 24; }   // ruwe terugval
}

/* Scryfall asks for a name and a calm pace; a handful of calls an hour is
   nothing, but the courtesy costs us nothing either. */
const SF_HEADERS = { 'User-Agent': 'Deckhand/1.0 (+https://deckhandcompanion.netlify.app)', 'Accept': 'application/json' };
const nap = (ms)=>new Promise(r=>setTimeout(r, ms));
/* Every card spoiled for a set that has not been released yet, newest
   first — the same query the app's own spoiler page runs. Reprints are not
   spoilers, so they never count. */
/* The art of a card (front face for a two-faced one): the browser shows a
   notification picture as a wide strip, and the art is the part of a card
   that fits that shape. The Android app draws the whole cards itself. */
function artOf(c){
  const iu = c.image_uris || (Array.isArray(c.card_faces) && c.card_faces[0] && c.card_faces[0].image_uris) || null;
  return (iu && iu.art_crop) || '';
}
async function spoiledCards(codes){
  const out = [];
  for(const code of codes){
    let url = 'https://api.scryfall.com/cards/search?unique=cards&order=spoiled&q=' + encodeURIComponent('set:' + code);
    for(let page = 0; page < 5 && url; page++){
      let d = null;
      try{
        const r = await fetch(url, { headers: SF_HEADERS });
        if(!r.ok) break;
        d = await r.json();
      }catch(e){ break; }               // one bad set never strands the rest
      (d.data || []).forEach(c => { if(!c.reprint) out.push({
        id: c.id, name: c.name, prev: (c.preview && c.preview.previewed_at) || '', art: artOf(c) }); });
      url = d.has_more ? d.next_page : null;
      await nap(120);
    }
  }
  return out;
}

/* `build` receives 'nl' or 'en' and returns the payload for that reader, so
   nobody gets a notification in a language they did not choose. Subscriptions
   saved before the language was recorded keep getting Dutch.
   `kind` is 'spoilers' or 'updates' — the two switches in Extras. A record
   that never recorded a switch counts as ON for both: those readers signed
   up when there was one switch for everything. */
/* Walk every subscription. `fn(rec, key, store)` returns the payload for
   that one reader, or null to skip them — which is how the spoiler lane
   applies each reader's own threshold. Dead endpoints are pruned. */
async function eachSub(fn){
  const subsStore = getStore('push-subs');
  let sent = 0, pruned = 0, skipped = 0;
  const { blobs } = await subsStore.list();
  for(const b of blobs || []){
    const rec = await subsStore.get(b.key, { type: 'json' });
    if(!rec || !rec.sub) continue;
    let payload = null;
    try{ payload = await fn(rec, b.key, subsStore); }catch(e){ payload = null; }
    if(!payload){ skipped++; continue; }
    try{ await webpush.sendNotification(rec.sub, JSON.stringify(payload)); sent++; }
    catch(e){
      const code = e && e.statusCode;
      if(code === 404 || code === 410){ await subsStore.delete(b.key); pruned++; }
    }
  }
  return { sent, pruned, skipped };
}
async function pushToAll(build, kind){
  return eachSub((rec)=>{
    if(kind && rec[kind] === false) return null;
    return build(rec.lang === 'en' ? 'en' : 'nl');
  });
}
/* How many new cards this reader waits for. A record from before the choice
   existed, or one that only ever knew on/off, means the old every-5. */
const SPOIL_EVERY = [0, 1, 5, 10];
function spoilerThreshold(rec){
  if(rec.spoilers === false) return 0;
  const n = parseInt(rec.spoilerEvery, 10);
  return SPOIL_EVERY.indexOf(n) > -1 ? n : 5;
}

export default async () => {
  // Notifications come from the Android app only (v2.51.629). The browser
  // lane stays in the code, switched off; DECKHAND_WEB_PUSH=on in Netlify's
  // environment brings it back without a code change.
  if(process.env.DECKHAND_WEB_PUSH !== 'on'){
    return new Response('web push off: Deckhand notifications come from the Android app');
  }
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if(!pub || !priv) return new Response('VAPID env vars missing', { status: 500 });
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://deckhandcompanion.netlify.app', pub, priv);
  const state = getStore('push-state');
  const report = [];
  const uur = dutchHour();
  if(uur < WINDOW_FROM || uur >= WINDOW_TO){
    return new Response(`asleep: ${uur}:00 Dutch time is outside ${WINDOW_FROM}:00–${WINDOW_TO}:00`);
  }

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
        const r = await pushToAll((lang)=>lang === 'en' ? {
          title: '🔮 A new Magic set is up',
          body: names + ' — the spoilers are gathering in Deckhand.',
          url: './?go=spoilers'
        } : {
          title: '🔮 Nieuwe Magic-set gespot',
          body: names + ' — de spoilers verzamelen zich in Deckhand.',
          url: './?go=spoilers'
        }, 'spoilers');
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
        const bulletsFor = (lang)=>(((v.notes && v.notes[lang]) || (v.notes && v.notes.nl) || [])
          .slice(0, 3).map(x => '• ' + x).join('\n'));
        const r = await pushToAll((lang)=>lang === 'en' ? {
          title: 'Deckhand Update — v' + v.version,
          body: bulletsFor('en') || 'Open the app to see what changed.',
          url: './'
        } : {
          title: 'Deckhand Update — v' + v.version,
          body: bulletsFor('nl') || 'Open de app voor de details.',
          url: './'
        }, 'updates');
        await state.setJSON('lastVersion', { version: v.version });
        report.push(`version: ${last.version} → ${v.version}, sent ${r.sent}, pruned ${r.pruned}`);
      } else report.push('version: unchanged ' + v.version);
    }
  }catch(e){ report.push('version check failed: ' + (e && e.message)); }

  // ---- 3. Newly spoiled cards, one push per five ----
  try{
    const res = await fetch('https://api.scryfall.com/sets', { headers: SF_HEADERS });
    if(res.ok){
      const sets = (await res.json()).data || [];
      const now = Date.now();
      const KINDS = new Set(['expansion','commander','masters','draft_innovation','core']);
      // Spoiler season = a paper set whose release day is still ahead.
      // De sets die het EERST uitkomen zijn de sets die nu gespoild worden;
      // die krijgen de aandacht als er meer dan zes tegelijk op de rol staan.
      const komend = sets.filter(s => {
        if(!KINDS.has(s.set_type) || s.digital) return false;
        const t = Date.parse(s.released_at || '');
        return t && t > now;
      }).sort((a, b) => String(a.released_at).localeCompare(String(b.released_at)))
        .map(s => s.code).slice(0, 6);
      const kaarten = komend.length ? await spoiledCards(komend) : [];
      // The log is a RUNNING COUNT, not a batch: every card ever spoiled gets
      // the next number. Each reader remembers the number they were last told
      // about, so one person can ask for every card and another for every ten
      // without either of them missing or repeating anything.
      const log = (await state.get('spoilerLog', { type: 'json' })) || null;
      const eerste = !log;
      const boek = log || { seq: 0, ids: [], recent: [] };
      const bekend = new Set(boek.ids || []);
      const verse = kaarten.filter(c => !bekend.has(c.id)).reverse();   // oldest first
      // A card we have not seen before is not necessarily NEWS. Scryfall
      // reorders, pages shift, a set enters the window late — and then a
      // card spoiled a week ago turns up looking fresh. Its own preview date
      // is the honest answer: older than three days, and it is filed away
      // without waking anybody.
      const OUD = 3 * 24 * 3600 * 1000;
      let gemeld = 0;
      verse.forEach(c => {
        boek.ids.push(c.id);
        const t = c.prev ? Date.parse(c.prev + 'T00:00:00Z') : NaN;
        if(Number.isFinite(t) && (now - t) > OUD) return;    // old news, quietly filed
        boek.seq = (boek.seq || 0) + 1;
        boek.recent.push({ seq: boek.seq, name: c.name, art: c.art || '' });
        gemeld++;
      });
      boek.ids = boek.ids.slice(-4000);
      boek.recent = boek.recent.slice(-200);
      await state.setJSON('spoilerLog', boek);
      if(eerste){
        report.push('spoilers: baseline ' + verse.length);   // first run says nothing
      } else if(!gemeld){
        report.push(`spoilers: nothing new (${verse.length - gemeld} filed as old)`);
      } else {
        const r = await eachSub(async (rec, key, store)=>{
          const drempel = spoilerThreshold(rec);
          if(!drempel) return null;
          let mijn = rec.spoilerSeq;
          if(!Number.isFinite(mijn)){
            // First sight of this reader: start their count at the round
            // BEFORE this one and write it down straight away. Without that
            // the count would restart every hour and a slow threshold could
            // never be reached.
            mijn = boek.seq - gemeld;
            rec = Object.assign({}, rec, { spoilerSeq: mijn });
            await store.setJSON(key, rec);
          }
          const aantal = boek.seq - mijn;
          if(aantal < drempel) return null;
          const mijnKaarten = boek.recent.filter(x => x.seq > mijn).slice(-3).reverse();
          const namen = mijnKaarten.map(x => x.name);
          const plaatje = (mijnKaarten.find(x => x.art) || {}).art || '';
          const rest = aantal - namen.length;
          await store.setJSON(key, Object.assign({}, rec, { spoilerSeq: boek.seq }));
          const en = rec.lang === 'en';
          const kop = aantal === 1
            ? (en ? '\u{1F52E} A new card was spoiled' : '\u{1F52E} Er is een nieuwe kaart gespoild')
            : (en ? '\u{1F52E} ' + aantal + ' new cards spoiled' : '\u{1F52E} ' + aantal + ' nieuwe kaarten gespoild');
          return {
            title: kop,
            body: namen.join(', ') + (rest > 0 ? (en ? ' and ' + rest + ' more' : ' en nog ' + rest) : '')
                  + (en ? ' — open Deckhand to see them.' : ' — open Deckhand om ze te bekijken.'),
            // One card: the tap opens it. More: the Spoilers page.
            url: aantal === 1 && namen[0] ? './?card=' + encodeURIComponent(namen[0]) : './?go=spoilers',
            image: plaatje || undefined
          };
        });
        report.push(`spoilers: ${gemeld} new, ${verse.length - gemeld} old (seq ${boek.seq}) → sent ${r.sent}, waiting ${r.skipped}, pruned ${r.pruned}`);
      }
    }
  }catch(e){ report.push('spoiler check failed: ' + (e && e.message)); }

  return new Response(report.join(' | '));
};

export const config = { schedule: '0 * * * *' };   // hourly; the window above decides whether anything is sent
