// WebSocket signaling + device discovery hub.
//
// Every browser (studio dashboards and media-source devices) opens one socket
// to /ws. The server keeps a roster of connected peers, broadcasts it on every
// change, and relays opaque messages (WebRTC offers/answers/ICE, remote
// control commands, tally) between peers. Media never flows through here.
//
// Protocol (JSON):
//   client -> server  {t:'hello', role, name, deviceId, info}
//                     {t:'state', state}            // source capabilities/sources
//                     {t:'relay', to, msg}          // forward msg to peer `to`
//   server -> client  {t:'welcome', id, peers, lanUrls}
//                     {t:'peers', peers}
//                     {t:'relay', from, msg}

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { joinableAddresses } from './certs.mjs';

const ROLES = new Set(['studio', 'source']);

export function attachSignaling(httpServer, { path = '/ws', exclusive = false, log = console.log } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  /** @type {Map<string, {ws: import('ws').WebSocket, id: string, role: string, name: string, deviceId: string, info: object, state: object, connectedAt: number, alive: boolean}>} */
  const peers = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    if (pathname !== path) {
      if (exclusive) socket.destroy();
      return; // let other upgrade handlers (e.g. Vite HMR) take it
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const publicInfo = (p) => ({
    id: p.id,
    role: p.role,
    name: p.name,
    deviceId: p.deviceId,
    info: p.info,
    state: p.state,
    connectedAt: p.connectedAt,
  });
  const roster = () => [...peers.values()].filter((p) => p.role).map(publicInfo);
  const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const broadcastRoster = () => {
    const msg = { t: 'peers', peers: roster() };
    for (const p of peers.values()) if (p.role) send(p.ws, msg);
  };

  wss.on('connection', (ws, req) => {
    const id = randomUUID().slice(0, 8);
    const peer = { ws, id, role: '', name: '', deviceId: '', info: {}, state: {}, connectedAt: Date.now(), alive: true };
    peers.set(id, peer);

    const hostHeader = req.headers.host ?? '';
    const port = hostHeader.includes(':') ? hostHeader.split(':').pop() : '443';

    ws.on('pong', () => (peer.alive = true));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (m.t) {
        case 'hello': {
          if (!ROLES.has(m.role)) return;
          peer.role = m.role;
          peer.name = String(m.name ?? '').slice(0, 64) || (m.role === 'studio' ? 'Studio' : 'Device');
          peer.deviceId = String(m.deviceId ?? id).slice(0, 64);
          peer.info = typeof m.info === 'object' && m.info ? m.info : {};
          peer.state = typeof m.state === 'object' && m.state ? m.state : {};
          // A device that reconnects replaces its stale session.
          for (const other of peers.values()) {
            if (other !== peer && other.deviceId === peer.deviceId && other.role === peer.role) {
              other.ws.terminate();
              peers.delete(other.id);
            }
          }
          send(ws, {
            t: 'welcome',
            id,
            peers: roster(),
            lanUrls: joinableAddresses().map((a) => ({ url: `https://${a.ip}:${port}`, kind: a.kind, label: a.label })),
          });
          log(`[signal] ${peer.role} "${peer.name}" joined (${id})`);
          broadcastRoster();
          break;
        }
        case 'state': {
          peer.state = typeof m.state === 'object' && m.state ? m.state : {};
          if (typeof m.name === 'string' && m.name) peer.name = m.name.slice(0, 64);
          broadcastRoster();
          break;
        }
        case 'relay': {
          const target = peers.get(m.to);
          if (target) send(target.ws, { t: 'relay', from: id, msg: m.msg });
          break;
        }
        case 'ping':
          send(ws, { t: 'pong' });
          break;
      }
    });
    ws.on('close', () => {
      if (peers.get(id) === peer) {
        peers.delete(id);
        if (peer.role) log(`[signal] ${peer.role} "${peer.name}" left (${id})`);
        broadcastRoster();
      }
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const p of peers.values()) {
      if (!p.alive) {
        p.ws.terminate();
        continue;
      }
      p.alive = false;
      try {
        p.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 10_000);
  wss.on('close', () => clearInterval(heartbeat));
  httpServer.on('close', () => wss.close());

  return wss;
}
