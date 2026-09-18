/* Admirals & Commanders — Magic news aggregator.
   Netlify Function. Lives at:  netlify/functions/news.js  in the repo,
   served at:  /.netlify/functions/news
   Aggregates two sources server-side (so the app never fights CORS):
   - EDHREC articles  — WordPress JSON API
   - MTGGoldfish      — RSS feed (first candidate URL that parses wins)
   Returns { items: [{ t, u, d, src }], fetched } sorted newest-first.
   No API keys, no dependencies — Node 18+ global fetch only. */

const UA = {
  headers: {
    'user-agent': 'AdmiralsAndCommanders/1.0 (+https://admirals-and-commanders.netlify.app)',
    'accept': 'application/json, application/rss+xml, application/xml, text/xml, */*'
  }
};

async function getJson(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

function stripTags(x) {
  return String(x || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRss(xml, src, cap) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < (cap || 12)) {
    const b = m[1];
    const grab = (tag) => {
      const mm = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      return mm ? mm[1] : '';
    };
    const t = stripTags(grab('title'));
    const u = stripTags(grab('link'));
    const rawDate = stripTags(grab('pubDate')) || stripTags(grab('dc:date'));
    let d = '';
    if (rawDate) { const dt = new Date(rawDate); if (!isNaN(dt)) d = dt.toISOString(); }
    if (t && u && /^https?:\/\//.test(u)) items.push({ t, u, d, src });
  }
  return items;
}

exports.handler = async () => {
  const out = [];

  // ── EDHREC: WordPress JSON API on the articles subsite.
  try {
    const posts = await getJson('https://edhrec.com/articles/wp-json/wp/v2/posts?per_page=10&_fields=title,link,date');
    if (Array.isArray(posts)) {
      for (const p of posts) {
        const t = stripTags(p && p.title && p.title.rendered);
        const u = p && p.link;
        if (!t || !u) continue;
        let d = '';
        if (p.date) { const dt = new Date(p.date); if (!isNaN(dt)) d = dt.toISOString(); }
        out.push({ t, u, d, src: 'EDHREC' });
      }
    }
  } catch (e) { /* one source down never empties the feed */ }

  // ── MTGGoldfish: RSS — the first candidate URL that yields items wins.
  const candidates = [
    'https://www.mtggoldfish.com/articles/feed',
    'https://www.mtggoldfish.com/feed',
    'https://www.mtggoldfish.com/articles.rss',
    'https://www.mtggoldfish.com/rss'
  ];
  for (const u of candidates) {
    try {
      const items = parseRss(await getText(u), 'MTGGoldfish', 12);
      if (items.length) { out.push(...items); break; }
    } catch (e) { /* try the next candidate */ }
  }

  out.sort((a, b) => String(b.d).localeCompare(String(a.d)));

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // CDN + browser may serve this for 30 min, refresh quietly for an hour.
      'cache-control': 'public, max-age=1800, stale-while-revalidate=3600',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify({ items: out.slice(0, 25), fetched: new Date().toISOString() })
  };
};
