import { defineConfig } from 'astro/config';
import webBroadcaster from './server/integration.mjs';
import { ensureCerts } from './server/certs.mjs';

// The dev server is always HTTPS (camera/mic on phones require it). A static
// build (`astro build`, e.g. for GitHub Pages) needs no certificates.
const isBuild = process.argv.includes('build');
const tls = isBuild ? null : await ensureCerts();

export default defineConfig({
  server: { host: true, port: Number(process.env.PORT ?? 4321) },
  devToolbar: { enabled: false },
  integrations: [webBroadcaster()],
  vite: {
    server: tls ? { https: { key: tls.key, cert: tls.cert } } : {},
  },
});
