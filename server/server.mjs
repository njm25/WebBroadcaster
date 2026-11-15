// Production server: serves the built Astro site (dist/) over HTTPS and hosts
// the signaling hub on the same port. Run `npm run build` first, then `npm start`.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { CA_URL_PATH, ensureCerts, printUrls, serveCaCert } from './certs.mjs';
import { attachSignaling } from './signaling.mjs';
import { restrictToLocalNetwork } from './access.mjs';

const PORT = Number(process.env.PORT ?? 4321);
const ROOT = path.resolve(process.cwd(), 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

if (!fs.existsSync(ROOT)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

function resolveFile(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  let file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
  return fs.existsSync(file) ? file : null;
}

const { key, cert } = await ensureCerts();
const server = https.createServer({ key, cert }, (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'https://local');
  if (pathname === CA_URL_PATH) return serveCaCert(res);
  const file = resolveFile(pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': pathname.startsWith('/_astro/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

restrictToLocalNetwork(server);
attachSignaling(server, { exclusive: true });
server.listen(PORT, '0.0.0.0', () => printUrls(PORT));
