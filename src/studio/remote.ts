// Remote device manager: one WebRTC connection per source device, mapping the
// device's published tracks (by MediaStream id) to studio inputs.

import { Emitter } from '../lib/emitter';
import { PeerLink } from '../lib/peer';
import type { ControlAction, PeerInfo, RelayMsg } from '../lib/protocol';
import type { SignalingLike } from '../lib/signaling';
import type { InputRegistry, InputType } from './inputs';

export interface TrackStats {
  fps?: number;
  width?: number;
  height?: number;
  kbps?: number;
}

export interface RemoteDevice {
  peer: PeerInfo;
  link: PeerLink;
  streams: Map<string, MediaStream>;
  stats: Map<string, TrackStats>;
  lastBytes: Map<string, { bytes: number; ts: number }>;
}

export const remoteInputId = (deviceId: string, key: string) => `${deviceId}:${key}`;

export class RemoteManager extends Emitter<{ change: [] }> {
  readonly devices = new Map<string, RemoteDevice>();

  constructor(
    private sig: SignalingLike,
    private registry: InputRegistry,
  ) {
    super();
    sig.on('peers', (peers) => this.onPeers(peers));
    sig.on('relay', (from, msg) => this.onRelay(from, msg));
    window.setInterval(() => void this.collectStats(), 2000);
  }

  private roster = new Set<string>();

  private onPeers(peers: PeerInfo[]) {
    const sources = peers.filter((p) => p.role === 'source');
    this.roster = new Set(sources.map((p) => p.id));
    for (const p of sources) {
      // A device that reconnected under a new session id replaces its old entry.
      for (const [id, old] of this.devices) {
        if (id !== p.id && old.peer.deviceId === p.deviceId) this.removeDevice(id);
      }
      let dev = this.devices.get(p.id);
      if (!dev) dev = this.createDevice(p);
      dev.peer = p;
      this.syncInputs(dev);
    }
    this.prune();
    this.emit('change');
  }

  /**
   * Remove devices that left the roster — unless their direct connection is
   * still up (relay presence can lapse briefly; the local link is what matters).
   */
  private prune() {
    for (const [id, dev] of this.devices) {
      if (!this.roster.has(id) && !dev.link.alive) this.removeDevice(id);
    }
  }

  private removeDevice(id: string) {
    const dev = this.devices.get(id);
    if (!dev) return;
    this.devices.delete(id); // before close(): its 'closed' event must not re-enter
    dev.link.close();
    for (const src of dev.peer.state.sources ?? []) {
      const inputId = remoteInputId(dev.peer.deviceId, src.key);
      this.registry.setOnline(inputId, false);
      this.registry.setStream(inputId, null);
    }
    this.emit('change');
  }

  private createDevice(peer: PeerInfo): RemoteDevice {
    const link = new PeerLink(peer.id, true, (msg) => this.sig.relay(peer.id, msg));
    const dev: RemoteDevice = { peer, link, streams: new Map(), stats: new Map(), lastBytes: new Map() };
    this.devices.set(peer.id, dev);
    link.on('track', (track, stream) => {
      const s = stream ?? new MediaStream([track]);
      dev.streams.set(s.id, s);
      track.addEventListener('unmute', () => this.syncInputs(dev));
      this.syncInputs(dev);
    });
    link.on('state', (s) => {
      if (this.devices.get(peer.id) !== dev) return;
      if (s === 'failed' || s === 'closed' || !link.alive) this.prune();
      if (this.devices.get(peer.id) !== dev) return;
      this.syncInputs(dev);
      this.emit('change');
    });
    return dev;
  }

  private onRelay(from: string, msg: RelayMsg) {
    if (msg.kind === 'rtc') void this.devices.get(from)?.link.handle(msg);
  }

  private syncInputs(dev: RemoteDevice) {
    const { peer, link } = dev;
    for (const src of peer.state.sources ?? []) {
      const id = remoteInputId(peer.deviceId, src.key);
      this.registry.upsert({
        id,
        kind: src.kind,
        type: src.key as InputType,
        label: src.label,
        origin: 'remote',
        deviceId: peer.deviceId,
        deviceName: peer.name,
        meta: { facing: src.facing, width: src.width, height: src.height, frameRate: src.frameRate, key: src.key },
      });
      const stream = src.streamId ? (dev.streams.get(src.streamId) ?? null) : null;
      this.registry.setStream(id, stream);
      this.registry.setOnline(id, !!stream && src.enabled && link.state === 'connected');
    }
  }

  control(peerId: string, action: ControlAction) {
    this.deliver(peerId, { kind: 'control', ...action } as RelayMsg);
  }

  /** Prefer the direct (local) data channel; fall back to signaling before it's open. */
  private deliver(peerId: string, msg: RelayMsg) {
    const dev = this.devices.get(peerId);
    if (!dev?.link.send(msg)) this.sig.relay(peerId, msg);
  }

  /** Tell each device which of its sources are on program/preview. */
  sendTally(program: Set<string>, preview: Set<string>, recording: boolean) {
    for (const dev of this.devices.values()) {
      const keys = (set: Set<string>) =>
        (dev.peer.state.sources ?? [])
          .filter((s) => set.has(remoteInputId(dev.peer.deviceId, s.key)))
          .map((s) => s.key);
      this.deliver(dev.peer.id, { kind: 'tally', program: keys(program), preview: keys(preview), recording });
    }
  }

  private async collectStats() {
    for (const dev of this.devices.values()) {
      if (dev.link.state !== 'connected') continue;
      // Map receiver track ids to source keys.
      const trackKey = new Map<string, string>();
      for (const src of dev.peer.state.sources ?? []) {
        const s = src.streamId ? dev.streams.get(src.streamId) : null;
        for (const t of s?.getTracks() ?? []) trackKey.set(t.id, src.key);
      }
      try {
        const report = await dev.link.pc.getStats();
        report.forEach((r) => {
          if (r.type !== 'inbound-rtp') return;
          const key = trackKey.get(r.trackIdentifier);
          if (!key) return;
          const prev = dev.lastBytes.get(key);
          const kbps = prev ? ((r.bytesReceived - prev.bytes) * 8) / (r.timestamp - prev.ts) : undefined;
          dev.lastBytes.set(key, { bytes: r.bytesReceived, ts: r.timestamp });
          dev.stats.set(key, {
            fps: r.framesPerSecond,
            width: r.frameWidth,
            height: r.frameHeight,
            kbps: kbps !== undefined ? Math.round(kbps) : undefined,
          });
        });
      } catch {
        /* ignore */
      }
    }
    this.emit('change');
  }
}
