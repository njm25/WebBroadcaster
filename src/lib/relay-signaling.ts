// Signaling through public MQTT relays, for when the page is hosted on the
// internet (e.g. GitHub Pages) and there is no local server to talk to.
//
// Only the connect-time handshake (WebRTC offers/answers/ICE) and small
// presence heartbeats pass through the relays. Every message is encrypted
// with AES-GCM using the room key from the join link's URL fragment, and the
// topic name is a hash of the room, so relay operators see neither the room
// nor the contents. Audio/video never touch the relays: WebRTC is restricted
// to local-network candidates (see netfilter.ts / peer.ts).

import { Emitter } from './emitter';
import { MqttBroker } from './mqtt';
import type { PeerInfo, RelayMsg, SourceState } from './protocol';
import type { Room } from './room';
import type { SignalStatus, SignalingEvents, SignalingLike, SignalingOptions } from './signaling';

/** Several independent public brokers; messages go to all of them for redundancy. */
export const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const HEARTBEAT_MS = 5000;
const EXPIRE_MS = 16000;
const MAX_SKEW_MS = 120_000;

type Body =
  | {
      t: 'hb';
      announce?: boolean;
      role: PeerInfo['role'];
      name: string;
      deviceId: string;
      info: PeerInfo['info'];
      state: Partial<SourceState>;
      since: number;
    }
  | { t: 'bye' }
  | { t: 'relay'; to: string; msg: RelayMsg };

type Envelope = Body & { v: 1; id: string; from: string; ts: number };

const rand = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export class RelaySignaling extends Emitter<SignalingEvents> implements SignalingLike {
  readonly mode = 'relay' as const;
  id: string | null = null;
  peers: PeerInfo[] = [];
  lanUrls = [];
  status: SignalStatus = 'closed';

  private brokers: MqttBroker[] = [];
  private key: CryptoKey | null = null;
  private state: Partial<SourceState> = {};
  private since = Date.now();
  private known = new Map<string, { info: PeerInfo; lastSeen: number }>();
  private seen = new Map<string, number>();
  private timers: number[] = [];
  private replyTimer: number | undefined;
  private rosterSig = '';
  private stopped = true;

  constructor(
    private opts: SignalingOptions,
    private room: Room,
  ) {
    super();
  }

  get label() {
    const open = this.brokers.filter((b) => b.status === 'open').length;
    return open ? `relays ${open}/${this.brokers.length}` : 'relays offline';
  }

  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.start();
  }

  private async start() {
    this.setStatus('connecting');
    const raw = fromB64url(this.room.key);
    this.key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`wb1|${this.room.id}|${this.room.key}`)),
    );
    const topic = `webbroadcaster/v1/${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (this.stopped) return;

    this.id = rand(4);
    this.since = Date.now();
    this.brokers = RELAY_BROKERS.map((url) => {
      const b = new MqttBroker(url, topic);
      b.onMessage = (_t, payload) => void this.receive(payload);
      b.onStatus = (s) => {
        if (s === 'open') {
          // (Re)joined a broker: announce so everyone (re)learns about us.
          void this.heartbeat(true);
        }
        this.updateStatus();
      };
      b.connect();
      return b;
    });
    this.timers.push(
      window.setInterval(() => void this.heartbeat(false), HEARTBEAT_MS),
      window.setInterval(() => this.expire(), 2000),
    );
  }

  close() {
    if (this.stopped) return;
    void this.send({ t: 'bye' });
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.replyTimer);
    // Give the goodbye a moment to leave before closing the sockets.
    const brokers = this.brokers;
    setTimeout(() => brokers.forEach((b) => b.close()), 150);
    this.brokers = [];
    this.known.clear();
    this.id = null;
    this.emitPeers(true);
    this.setStatus('closed');
  }

  setName(name: string) {
    this.opts.name = name;
    void this.heartbeat(false);
  }

  setState(state: Partial<SourceState>) {
    this.state = state;
    void this.heartbeat(false);
  }

  relay(to: string, msg: RelayMsg) {
    void this.send({ t: 'relay', to, msg });
  }

  // ---------------------------------------------------------------- internals
  private setStatus(s: SignalStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private updateStatus() {
    if (this.stopped) return;
    const anyOpen = this.brokers.some((b) => b.status === 'open');
    const was = this.status;
    this.setStatus(anyOpen ? 'open' : 'connecting');
    if (anyOpen && was !== 'open' && this.id) {
      this.emit('welcome', { id: this.id, lanUrls: [] });
      this.emitPeers(true);
    }
    if (!anyOpen) this.emit('status', this.status); // refresh labels
  }

  private heartbeat(announce: boolean) {
    if (this.stopped || !this.id) return;
    return this.send({
      t: 'hb',
      announce,
      role: this.opts.role,
      name: this.opts.name,
      deviceId: this.opts.deviceId,
      info: this.opts.info ?? {},
      state: this.state,
      since: this.since,
    });
  }

  private async send(body: Body) {
    if (!this.key || !this.id) return;
    const env: Envelope = { ...body, v: 1, id: rand(8), from: this.id, ts: Date.now() } as Envelope;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(JSON.stringify(env))),
    );
    const payload = new Uint8Array(iv.length + ct.length);
    payload.set(iv);
    payload.set(ct, iv.length);
    for (const b of this.brokers) b.publish(payload);
  }

  private async receive(payload: Uint8Array) {
    if (!this.key || payload.length < 29) return;
    let env: Envelope;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: payload.slice(0, 12) },
        this.key,
        payload.slice(12),
      );
      env = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return; // not for us / tampered
    }
    if (env.v !== 1 || !env.from || env.from === this.id) return;
    if (Math.abs(Date.now() - env.ts) > MAX_SKEW_MS) return;
    if (this.seen.has(env.id)) return; // duplicate via another broker
    this.seen.set(env.id, env.ts);
    if (this.seen.size > 2000) {
      const cutoff = Date.now() - MAX_SKEW_MS;
      for (const [k, ts] of this.seen) if (ts < cutoff) this.seen.delete(k);
    }

    if (env.t === 'hb') {
      const isNew = !this.known.has(env.from);
      // Same device reconnecting with a new session id: keep only the newest.
      for (const [id, k] of this.known) {
        if (id !== env.from && k.info.deviceId === env.deviceId && k.info.role === env.role) {
          if (k.info.connectedAt > env.since) return;
          this.known.delete(id);
        }
      }
      this.known.set(env.from, {
        lastSeen: Date.now(),
        info: {
          id: env.from,
          role: env.role,
          name: String(env.name ?? '').slice(0, 64),
          deviceId: String(env.deviceId ?? env.from).slice(0, 64),
          info: env.info ?? {},
          state: env.state ?? {},
          connectedAt: env.since,
        },
      });
      if (isNew || env.announce) this.scheduleReply();
      this.emitPeers();
    } else if (env.t === 'bye') {
      if (this.known.delete(env.from)) this.emitPeers();
    } else if (env.t === 'relay' && env.to === this.id) {
      this.emit('relay', env.from, env.msg);
    }
  }

  /** Answer newcomers quickly (debounced so a burst of joins causes one reply). */
  private scheduleReply() {
    if (this.replyTimer) return;
    this.replyTimer = window.setTimeout(() => {
      this.replyTimer = undefined;
      void this.heartbeat(false);
    }, 150 + Math.random() * 250);
  }

  private expire() {
    const now = Date.now();
    let changed = false;
    for (const [id, k] of this.known) {
      if (now - k.lastSeen > EXPIRE_MS) {
        this.known.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitPeers();
  }

  private emitPeers(force = false) {
    const peers = [...this.known.values()].map((k) => k.info);
    const sig = JSON.stringify(peers);
    if (!force && sig === this.rosterSig) return;
    this.rosterSig = sig;
    this.peers = peers;
    this.emit('peers', peers);
  }
}
