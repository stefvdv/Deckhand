/* Deckhand — Magic news aggregator.
   Netlify Function. Lives at:  netlify/functions/news.js  in the repo,
   served at:  <your-site>/.netlify/functions/news  (the app calls it
   by relative path, so the site's name never matters here).
   Aggregates two sources server-side (so the app never fights CORS):
   - EDHREC articles  — WordPress JSON API
   - MTGGoldfish      — RSS feed (first candidate URL that parses wins)
   Division of labour: EDHREC owns Commander (their whole site is Commander;
   their categories are content types, not formats), MTGGoldfish covers every
   OTHER format — its Atom feed carries no category metadata, so the format is
   inferred from the article's URL slug and title, and Commander pieces are
   dropped there to avoid doubling up.
   Returns { items: [{ t, u, d, src, img, x, fmt }], fetched } newest-first
   (img = thumbnail, x = excerpt, fmt = detected format or '').
   No API keys, no dependencies — Node 18+ global fetch only. */

const UA = {
  headers: {
    // Browser-like UA: some feed hosts sit behind Cloudflare and turn away
    // obvious bot strings.
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 DeckhandNews/1.0',
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

/* Format detection for sources without category metadata. Order matters:
   Commander first (so "Foundations Commander Decklists" is recognised as
   Commander whatever else it mentions), premodern before modern. */
const FMT_RULES = [
  ['commander', /\b(commander|cedh|edh|pdh|precons?)\b/i],
  ['brawl',     /\bbrawl\b/i],
  ['premodern', /\bpre-?modern\b/i],
  ['pauper',    /\bpauper\b/i],
  ['legacy',    /\blegacy\b/i],
  ['vintage',   /\bvintage\b/i],
  ['modern',    /\bmodern\b/i],
  ['pioneer',   /\bpioneer\b/i],
  ['standard',  /\bstandard\b/i],
  ['historic',  /\b(historic|timeless|alchemy|arena)\b/i],
  ['limited',   /\b(limited|draft|sealed|prerelease)\b/i]
];
/* MTGGoldfish column names that pin a format the words alone don't. */
const SERIES_RULES = [
  ['legacy',    /this-week-in-legacy/i],
  ['pauper',    /power-of-pauper/i],
  ['vintage',   /vintage-101/i],
  ['standard',  /fish-five-o/i],
  ['commander', /commander-clash|precon-primer/i]
];
function detectFormat(text) {
  for (const [f, re] of SERIES_RULES) if (re.test(text)) return f;
  for (const [f, re] of FMT_RULES) if (re.test(text)) return f;
  return '';
}

function parseFeed(xml, src, cap) {
  const items = [];
  // RSS uses <item>, Atom uses <entry> — MTGGoldfish serves Atom, most
  // others RSS. One walker handles both.
  const re = /<(item|entry)[\s>]([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < (cap || 12)) {
    const b = m[2];
    const grab = (tag) => {
      const mm = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      return mm ? mm[1] : '';
    };
    const t = stripTags(grab('title'));
    // Atom links live in the href attribute of a self-closing <link/>.
    let u = stripTags(grab('link'));
    if (!/^https?:\/\//.test(u)) {
      const lm = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
              || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      u = lm ? lm[1] : '';
    }
    const rawDate = stripTags(grab('pubDate')) || stripTags(grab('published')) || stripTags(grab('updated')) || stripTags(grab('dc:date'));
    let d = '';
    if (rawDate) { const dt = new Date(rawDate); if (!isNaN(dt)) d = dt.toISOString(); }
    let img = '';
    const mm2 = b.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i)
             || b.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp|gif)[^"']*)["']/i)
             || b.match(/<img[^>]*src=["']([^"']+)["']/i);
    if (mm2) img = mm2[1].replace(/&amp;/g, '&');
    if (!/^https:\/\//.test(img)) img = '';
    const x = stripTags(grab('description') || grab('summary') || grab('content')).slice(0, 400);
    // The slug is the most reliable signal, then the title, then the blurb.
    const fmt = detectFormat(u + ' ' + t.replace(/-/g, ' ') + ' ' + x.slice(0, 160));
    if (t && u && /^https?:\/\//.test(u)) items.push({ t, u, d, src, img, x, fmt });
  }
  return items;
}

exports.handler = async () => {
  const out = [];

  // ── EDHREC: WordPress JSON API on the articles subsite.
  try {
    // Full objects on purpose: this WP ignores _fields, and the thumbnail
    // hides in different places per config (embedded media vs Yoast og:image).
    const posts = await getJson('https://edhrec.com/articles/wp-json/wp/v2/posts?per_page=10&_embed=wp:featuredmedia');
    if (Array.isArray(posts)) {
      for (const p of posts) {
        const t = stripTags(p && p.title && p.title.rendered);
        const u = p && p.link;
        if (!t || !u) continue;
        let d = '';
        if (p.date) { const dt = new Date(p.date); if (!isNaN(dt)) d = dt.toISOString(); }
        let img = '';
        try {
          const fm = p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0];
          const sizes = fm && fm.media_details && fm.media_details.sizes;
          img = (sizes && ((sizes.medium_large && sizes.medium_large.source_url) || (sizes.medium && sizes.medium.source_url)))
             || (fm && fm.source_url) || '';
          if (!img && p.yoast_head_json && Array.isArray(p.yoast_head_json.og_image) && p.yoast_head_json.og_image[0]) {
            img = p.yoast_head_json.og_image[0].url || '';
          }
          if (!img && typeof p.yoast_head === 'string') {
            const om = p.yoast_head.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                    || p.yoast_head.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
            if (om) img = om[1];
          }
        } catch (e) {}
        if (!/^https:\/\//.test(img)) img = '';
        let x = stripTags(p.excerpt && p.excerpt.rendered);
        if (!x) x = stripTags(p.content && p.content.rendered).slice(0, 400);
        x = x.replace(/\s*\[\u2026\]$/, '\u2026').slice(0, 400);
        out.push({ t, u, d, src: 'EDHREC', img, x, fmt: 'commander' });
      }
    }
  } catch (e) { /* one source down never empties the feed */ }

  // ── MTGGoldfish: RSS — the first candidate URL that yields items wins.
  const candidates = [
    'https://www.mtggoldfish.com/feed',            // verified live
    'https://www.mtggoldfish.com/articles/feed',
    'https://www.mtggoldfish.com/articles.rss'
  ];
  for (const u of candidates) {
    try {
      const items = parseFeed(await getText(u), 'MTGGoldfish', 20);
      if (items.length) {
        // EDHREC already owns Commander — keep Goldfish for everything else.
        out.push(...items.filter(it => it.fmt !== 'commander').slice(0, 12));
        break;
      }
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
