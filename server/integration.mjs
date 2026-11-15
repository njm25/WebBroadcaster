// Astro integration: attaches the signaling hub to Astro's dev server so
// `npm run dev` gives you HTTPS pages + WebSocket signaling on one port.
import { attachSignaling } from './signaling.mjs';
import { CA_URL_PATH, printUrls, serveCaCert } from './certs.mjs';
import { restrictToLocalNetwork } from './access.mjs';

export default function webBroadcaster() {
  return {
    name: 'webbroadcaster-signaling',
    hooks: {
      'astro:server:setup': ({ server, logger }) => {
        if (!server.httpServer) return;
        restrictToLocalNetwork(server.httpServer, (m) => logger.warn(m));
        server.middlewares.use(CA_URL_PATH, (_req, res) => serveCaCert(res));
        attachSignaling(server.httpServer, { log: (m) => logger.info(m) });
      },
      'astro:server:start': ({ address }) => {
        printUrls(address.port);
      },
    },
  };
}
