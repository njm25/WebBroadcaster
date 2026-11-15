// Input registry: every live media track available to the studio, whether it
// comes from a remote device (WebRTC) or this computer (getUserMedia /
// getDisplayMedia). Inputs are single-kind (video OR audio) and have stable
// ids so scenes and mixer settings survive reconnects and reloads.

import { Emitter } from '../lib/emitter';
import { loadJSON, saveJSON } from '../lib/util';

export type InputKind = 'video' | 'audio';
export type InputType = 'camera' | 'mic' | 'screen' | 'screen-audio' | 'webcam' | 'local-mic';

export interface Input {
  id: string;
  kind: InputKind;
  type: InputType;
  label: string;
  origin: 'remote' | 'local';
  /** Persistent device id of the owning device ('local' for this computer). */
  deviceId: string;
  deviceName: string;
  stream: MediaStream | null;
  online: boolean;
  /** Hidden element used to decode video frames / keep remote audio flowing. */
  el?: HTMLVideoElement | HTMLAudioElement;
  /** Extra info (resolution, facing...) shown in the UI. */
  meta?: Record<string, unknown>;
}

interface PersistedInput {
  id: string;
  kind: InputKind;
  type: InputType;
  label: string;
  origin: 'remote' | 'local';
  deviceId: string;
  deviceName: string;
  meta?: Record<string, unknown>;
}

const STORAGE_KEY = 'wb.inputs';

export class InputRegistry extends Emitter<{ change: []; stream: [Input]; resize: [Input, number, number] }> {
  readonly inputs = new Map<string, Input>();
  private host: HTMLElement;
  private saveTimer: number | undefined;

  constructor() {
    super();
    // Offscreen (but rendered) container so browsers keep decoding frames.
    this.host = document.createElement('div');
    Object.assign(this.host.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '2px',
      height: '2px',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
    });
    document.body.append(this.host);

    // Restore known inputs as offline placeholders.
    for (const p of loadJSON<PersistedInput[]>(STORAGE_KEY, [])) {
      this.inputs.set(p.id, { ...p, stream: null, online: false });
    }
  }

  get(id: string) {
    return this.inputs.get(id);
  }

  list(kind?: InputKind) {
    const all = [...this.inputs.values()];
    return kind ? all.filter((i) => i.kind === kind) : all;
  }

  /** Create or update an input's descriptive fields. */
  upsert(desc: Omit<Input, 'stream' | 'online' | 'el'> & Partial<Pick<Input, 'online'>>) {
    const cur = this.inputs.get(desc.id);
    if (cur) {
      Object.assign(cur, desc);
    } else {
      this.inputs.set(desc.id, { ...desc, stream: null, online: desc.online ?? false });
    }
    this.persist();
    this.emit('change');
    return this.inputs.get(desc.id)!;
  }

  setStream(id: string, stream: MediaStream | null) {
    const input = this.inputs.get(id);
    if (!input || input.stream === stream) return;
    input.stream = stream;
    if (stream) {
      if (!input.el) {
        const el = document.createElement(input.kind === 'video' ? 'video' : 'audio');
        el.autoplay = true;
        el.muted = true; // audio is routed through the Web Audio mixer instead
        if (el instanceof HTMLVideoElement) {
          el.playsInline = true;
          // Fires when the decoded frame size changes, e.g. a phone rotates.
          el.addEventListener('resize', () => {
            if (el.videoWidth && el.videoHeight) this.emit('resize', input, el.videoWidth, el.videoHeight);
          });
        }
        this.host.append(el);
        input.el = el;
      }
      input.el.srcObject = stream;
      void input.el.play().catch(() => {});
    } else if (input.el) {
      input.el.srcObject = null;
    }
    this.emit('stream', input);
    this.emit('change');
  }

  setOnline(id: string, online: boolean) {
    const input = this.inputs.get(id);
    if (!input || input.online === online) return;
    input.online = online;
    this.emit('change');
  }

  remove(id: string) {
    const input = this.inputs.get(id);
    if (!input) return;
    input.el?.remove();
    this.inputs.delete(id);
    this.persist();
    this.emit('change');
  }

  /** Retry playback of all media elements (after a user gesture). */
  kick() {
    for (const i of this.inputs.values()) if (i.el?.paused && i.stream) void i.el.play().catch(() => {});
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveJSON(
        STORAGE_KEY,
        [...this.inputs.values()].map(({ id, kind, type, label, origin, deviceId, deviceName, meta }) => ({
          id,
          kind,
          type,
          label,
          origin,
          deviceId,
          deviceName,
          meta,
        })),
      );
    }, 300);
  }
}

/** Frame source for drawing an input to canvas, or null if no frames yet. */
export function videoFrameOf(input: Input | undefined): HTMLVideoElement | null {
  const el = input?.el;
  if (!input?.online || !(el instanceof HTMLVideoElement)) return null;
  if (el.readyState < 2 || !el.videoWidth) return null;
  return el;
}
