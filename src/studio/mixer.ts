// Web Audio mixer. Each audio input gets a channel strip:
//   source -> sync delay -> fader/mute -> (meter) -> master bus -> recording
//                                      \-> monitor bus -> speakers (optional)

import { Emitter } from '../lib/emitter';
import { loadJSON, saveJSON } from '../lib/util';
import type { Input, InputRegistry } from './inputs';

export interface ChannelSettings {
  volumeDb: number;
  muted: boolean;
  monitor: boolean;
  delayMs: number;
}

const DEFAULTS: ChannelSettings = { volumeDb: 0, muted: false, monitor: false, delayMs: 0 };
export const MIN_DB = -60;
export const MAX_DB = 12;
const STORAGE_KEY = 'wb.mixer';
export const MASTER = '__master__';

export const dbToGain = (db: number) => (db <= MIN_DB ? 0 : 10 ** (db / 20));

interface Channel {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  delay: DelayNode;
  fader: GainNode;
  analyser: AnalyserNode;
  monitor: GainNode;
  peak: number;
  hold: number;
}

export class Mixer extends Emitter<{ change: [] }> {
  readonly ctx: AudioContext;
  readonly output: MediaStreamAudioDestinationNode;
  private master: GainNode;
  private masterAnalyser: AnalyserNode;
  private masterMonitor: GainNode;
  private monitorBus: GainNode;
  private channels = new Map<string, Channel>();
  private settings: Record<string, ChannelSettings> = loadJSON(STORAGE_KEY, {});
  private buf = new Float32Array(2048);
  private masterLevel = { peak: 0, hold: 0 };

  constructor(private registry: InputRegistry) {
    super();
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this.output = this.ctx.createMediaStreamDestination();
    this.master = this.ctx.createGain();
    this.masterAnalyser = this.makeAnalyser();
    this.masterMonitor = this.ctx.createGain();
    this.monitorBus = this.ctx.createGain();
    this.master.connect(this.masterAnalyser);
    this.master.connect(this.output);
    this.master.connect(this.masterMonitor);
    this.masterMonitor.connect(this.ctx.destination);
    this.monitorBus.connect(this.ctx.destination);
    this.applyMaster();

    registry.on('stream', (input) => input.kind === 'audio' && this.sync());
    registry.on('change', () => this.sync());
    this.ctx.addEventListener('statechange', () => this.emit('change'));
    this.sync();
  }

  get running() {
    return this.ctx.state === 'running';
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume().then(() => this.emit('change'));
  }

  get(id: string): ChannelSettings {
    return { ...DEFAULTS, ...this.settings[id] };
  }

  set(id: string, patch: Partial<ChannelSettings>) {
    this.settings[id] = { ...this.get(id), ...patch };
    saveJSON(STORAGE_KEY, this.settings);
    if (id === MASTER) this.applyMaster();
    else this.apply(id);
    this.emit('change');
  }

  /** Audio inputs shown in the mixer, live ones first. */
  strips(): Input[] {
    return this.registry
      .list('audio')
      .sort((a, b) => Number(b.online) - Number(a.online) || a.deviceName.localeCompare(b.deviceName));
  }

  private makeAnalyser() {
    const a = this.ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0;
    return a;
  }

  private sync() {
    const wanted = new Map<string, MediaStream>();
    for (const i of this.registry.list('audio')) {
      if (i.stream && i.stream.getAudioTracks().length) wanted.set(i.id, i.stream);
    }
    for (const [id, ch] of this.channels) {
      if (wanted.get(id) !== ch.stream) {
        ch.source.disconnect();
        ch.fader.disconnect();
        ch.monitor.disconnect();
        this.channels.delete(id);
      }
    }
    for (const [id, stream] of wanted) {
      if (this.channels.has(id)) continue;
      const source = this.ctx.createMediaStreamSource(stream);
      const delay = this.ctx.createDelay(2);
      const fader = this.ctx.createGain();
      const analyser = this.makeAnalyser();
      const monitor = this.ctx.createGain();
      source.connect(delay).connect(fader);
      fader.connect(analyser);
      fader.connect(this.master);
      fader.connect(monitor).connect(this.monitorBus);
      this.channels.set(id, { stream, source, delay, fader, analyser, monitor, peak: 0, hold: 0 });
      this.apply(id);
    }
    this.emit('change');
  }

  private apply(id: string) {
    const ch = this.channels.get(id);
    if (!ch) return;
    const s = this.get(id);
    const t = this.ctx.currentTime;
    ch.fader.gain.setTargetAtTime(s.muted ? 0 : dbToGain(s.volumeDb), t, 0.015);
    ch.monitor.gain.setTargetAtTime(s.monitor ? 1 : 0, t, 0.015);
    ch.delay.delayTime.setTargetAtTime(Math.min(2, s.delayMs / 1000), t, 0.01);
  }

  private applyMaster() {
    const s = this.get(MASTER);
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : dbToGain(s.volumeDb), t, 0.015);
    this.masterMonitor.gain.setTargetAtTime(s.monitor ? 1 : 0, t, 0.015);
  }

  /** Peak level in dBFS (post-fader) with a short hold, for meters. */
  level(id: string): { db: number; hold: number } {
    const isMaster = id === MASTER;
    const ch = isMaster ? null : this.channels.get(id);
    const analyser = isMaster ? this.masterAnalyser : ch?.analyser;
    const state = isMaster ? this.masterLevel : ch;
    if (!analyser || !state) return { db: -Infinity, hold: -Infinity };
    analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i]);
      if (v > peak) peak = v;
    }
    // Ballistics: instant attack, smooth release; hold decays slowly.
    state.peak = peak > state.peak ? peak : state.peak * 0.85 + peak * 0.15;
    state.hold = peak > state.hold ? peak : state.hold * 0.985;
    const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    return { db: toDb(state.peak), hold: toDb(state.hold) };
  }
}
