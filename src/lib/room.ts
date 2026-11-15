// Studio "rooms" for relay signaling. A room is an id plus a 256-bit key.
// Both travel only in the URL fragment (#r=…&k=…), which browsers never send
// to any server, so the relays can't read or join the studio's traffic.

import { isPrivateHost } from './netfilter';
import { loadJSON, saveJSON } from './util';

export interface Room {
  id: string;
  key: string; // base64url, 32 bytes
}

export type SignalMode = 'local' | 'relay';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function newRoom(): Room {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const idBytes = crypto.getRandomValues(new Uint8Array(8));
  const id = [...idBytes].map((b) => alphabet[b % alphabet.length]).join('');
  return { id, key: b64url(crypto.getRandomValues(new Uint8Array(32))) };
}

export function roomFromHash(hash = location.hash): Room | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const id = p.get('r');
  const key = p.get('k');
  return id && key && /^[A-Za-z0-9_-]{43}$/.test(key) ? { id, key } : null;
}

/** The studio's room, created on first use and kept across reloads. */
export function studioRoom(): Room {
  const saved = loadJSON<Room | null>('wb.room', null);
  if (saved?.id && saved.key) return saved;
  const room = newRoom();
  saveJSON('wb.room', room);
  return room;
}

export function resetStudioRoom(): Room {
  const room = newRoom();
  saveJSON('wb.room', room);
  return room;
}

/**
 * How devices find each other:
 *  - 'local': page served by the WebBroadcaster server on this network → its WebSocket hub
 *  - 'relay': page hosted elsewhere (e.g. GitHub Pages) → encrypted public relays
 * Override with ?signal=local|relay.
 */
export function signalMode(): SignalMode {
  const forced = new URLSearchParams(location.search).get('signal');
  if (forced === 'local' || forced === 'relay') return forced;
  return isPrivateHost(location.hostname) ? 'local' : 'relay';
}

/** Site base path ("/" locally, "/<repo>/" on GitHub project pages). */
export function basePath(): string {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

/** Link a phone opens to join this studio's room. */
export function joinUrl(room: Room): string {
  const url = new URL(`${basePath()}source/`, location.origin);
  if (new URLSearchParams(location.search).get('signal') === 'relay') url.searchParams.set('signal', 'relay');
  url.hash = `r=${room.id}&k=${room.key}`;
  return url.toString();
}
