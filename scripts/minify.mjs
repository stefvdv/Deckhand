// Deckhand — make index.html smaller when Netlify publishes the site.
//
// Runs as Netlify's build command (netlify.toml). It shrinks the app's big
// script and its style sheet in the BUILD COPY only: the readable index.html
// in GitHub stays exactly as it is. The phone downloads and reads about a
// third less, so the app starts faster.
//
// Safe by design: if anything looks wrong, the file is left untouched and
// the site goes out readable, as before.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const FILE = process.argv[2] || 'index.html';
const src = readFileSync(FILE, 'utf8');
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
const gz = (s) => (gzipSync(s).length / 1024).toFixed(0) + ' KB gzip';

try {
  const { transform } = await import('esbuild');   // inside try: no esbuild = readable site, not a failed deploy
  // the app script: the largest plain <script> block
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!scripts.length) throw new Error('no script found');
  const big = scripts.reduce((a, b) => (b[1].length > a[1].length ? b : a));
  if (big[1].length < 500000) throw new Error('app script not found');
  // Classic script: esbuild keeps every top-level name (other code and the
  // small boot scripts call them), it only shortens what is local.
  const js = (await transform(big[1], { loader: 'js', minify: true, legalComments: 'none', charset: 'utf8' })).code;
  if (/<\/script/i.test(js)) throw new Error('script would close early');

  // the style sheet: the first <style> block in <head>
  const st = src.match(/<style>([\s\S]*?)<\/style>/);
  if (!st || st[1].length < 100000) throw new Error('style sheet not found');
  const css = (await transform(st[1], { loader: 'css', minify: true, charset: 'utf8' })).code;

  let out = src.slice(0, big.index) + '<script>' + js + '</script>' + src.slice(big.index + big[0].length);
  out = out.replace(st[0], () => '<style>' + css + '</style>');

  if (out.length > src.length * 0.9) throw new Error('hardly smaller, something is off');
  writeFileSync(FILE, out);
  console.log(`index.html: ${kb(src)} (${gz(src)}) → ${kb(out)} (${gz(out)})`);
} catch (e) {
  console.log('index.html left as it is: ' + e.message);
}
