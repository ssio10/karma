// Baut aus src/ eine einzige index.html (CSS und JS eingebettet) für GitHub Pages.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
const src = new URL('./src/', import.meta.url);
const read = f => readFileSync(new URL(f, src), 'utf8');
let html = read('index.html');
let n = 0;
html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (m, f) => { n++; return '<style>\n' + read(f) + '\n</style>'; });
html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (m, f) => {
  if (/^https?:/.test(f)) throw new Error('Externe Skripte sind nicht erlaubt: ' + f);
  n++; return '<script>\n' + read(f).replace(/<\/script/gi, '<\\/script') + '\n</script>';
});
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
html = html.replace('__BUILD__', stamp);
writeFileSync(new URL('./index.html', import.meta.url), html);
// Kopie für den Handy-Test im WLAN: der Ordner dist/ enthält nur das Spiel, sonst nichts aus dem Projekt.
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), html);
// Bilder (Tische, Kartenfiguren, Rückseiten) bleiben eigene Dateien: Ordner img/ neben der Seite.
const imgs = readdirSync(new URL('img/', src)).filter(f => /\.(jpg|png|webp)$/.test(f));
for (const dir of ['./img/', './dist/img/']) {
  rmSync(new URL(dir, import.meta.url), { recursive: true, force: true });
  mkdirSync(new URL(dir, import.meta.url), { recursive: true });
  for (const f of imgs) cpSync(new URL('img/' + f, src), new URL(dir + f, import.meta.url));
}
for (const m of html.matchAll(/img\/[a-z0-9-]+\.jpg/g)) if (!imgs.includes(m[0].slice(4))) throw new Error('Bild fehlt: ' + m[0]);
console.log(`${imgs.length} Bilder kopiert`);
console.log(`index.html gebaut: ${n} Dateien eingebettet, ${(html.length / 1024).toFixed(1)} kB`);
