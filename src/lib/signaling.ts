import { Emitter } from './emitter';
import type { LanUrl, PeerInfo, RelayMsg, Role, ServerMsg, SourceState } from './protocol';
import { RelaySignaling } from './relay-signaling';
import type { Room, SignalMode } from './room';

export type SignalStatus = 'connecting' | 'open' | 'closed';

export interface SignalingOptions {
  role: Role;
  name: string;
  deviceId: string;
  info?: PeerInfo['info'];
}

export type SignalingEvents = {
  status: [SignalStatus];
  welcome: [{ id: string; lanUrls: LanUrl[] }];
  peers: [PeerInfo[]];
  relay: [string, RelayMsg];
};

/** Common surface of the local WebSocket hub client and the relay client. */
export interface SignalingLike extends Emitter<SignalingEvents> {
  readonly mode: 'local' | 'relay';
  id: string | null;
  peers: PeerInfo[];
  lanUrls: LanUrl[];
  status: SignalStatus;
  /** Short status text for the UI, e.g. "server" or "relays 3/3". */
  readonly label: string;
  connect(): void;
  close(): void;
  setName(name: string): void;
  setState(state: Partial<SourceState>): void;
  relay(to: string, msg: RelayMsg): void;
}

/**
 * Reconnecting WebSocket client for the local signaling hub. Re-announces
 * itself (and its last published state) after every reconnect.
 */
export class Signaling extends Emitter<SignalingEvents> implements SignalingLike {
  readonly mode = 'local' as const;
  id: string | null = null;
  peers: PeerInfo[] = [];
  lanUrls: LanUrl[] = [];
  status: SignalStatus = 'closed';

  get label() {
    return this.status === 'open' ? 'server' : 'server offline';
  }

  private ws: WebSocket | null = null;
  private state: Partial<SourceState> = {};
  private stopped = true;
  private retry = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;

  constructor(private opts: SignalingOptions) {
    super();
  }

  get name() {
    return this.opts.name;
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.id = null;
    this.peers = [];
    this.setStatus('closed');
  }

  setName(name: string) {
    this.opts.name = name;
    this.send({ t: 'state', state: this.state, name });
  }

  setState(state: Partial<SourceState>) {
    this.state = state;
    this.send({ t: 'state', state });
  }

  relay(to: string, msg: RelayMsg) {
    this.send({ t: 'relay', to, msg });
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private setStatus(s: SignalStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.setStatus('connecting');

    ws.onopen = () => {
      this.retry = 0;
      ws.send(
        JSON.stringify({
          t: 'hello',
          role: this.opts.role,
          name: this.opts.name,
          deviceId: this.opts.deviceId,
          info: this.opts.info ?? {},
          state: this.state,
        }),
      );
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 15_000);
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        this.id = m.id;
        this.lanUrls = m.lanUrls;
        this.peers = m.peers;
        this.setStatus('open');
        this.emit('welcome', { id: m.id, lanUrls: m.lanUrls });
        this.emit('peers', m.peers);
      } else if (m.t === 'peers') {
        this.peers = m.peers;
        this.emit('peers', m.peers);
      } else if (m.t === 'relay') {
        this.emit('relay', m.from, m.msg);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.id = null;
      this.peers = [];
      this.emit('peers', []);
      this.setStatus(this.stopped ? 'closed' : 'connecting');
      if (!this.stopped) {
        const delay = Math.min(8000, 500 * 2 ** this.retry++);
        this.retryTimer = window.setTimeout(() => this.open(), delay);
      }
    };
    ws.onerror = () => ws.close();
  }
}

/** Pick the signaling transport for how this page was loaded (see room.ts). */
export function createSignaling(opts: SignalingOptions, mode: SignalMode, room: Room | null): SignalingLike {
  if (mode === 'local') return new Signaling(opts);
  if (!room) throw new Error('Relay signaling needs a room');
  return new RelaySignaling(opts, room);
}
