// Media captured on the studio computer itself: webcams, microphones and
// screen/window/tab capture.

import { loadJSON, saveJSON, uid } from '../lib/util';
import type { InputRegistry, InputType } from './inputs';

export type Surface = 'monitor' | 'window' | 'browser';

interface LocalDescriptor {
  id: string;
  type: 'webcam' | 'local-mic' | 'screen';
  deviceId?: string;
  surface?: Surface;
  label: string;
}

const STORAGE_KEY = 'wb.local';

export class LocalSources {
  private descriptors: LocalDescriptor[] = loadJSON(STORAGE_KEY, []);
  private streams = new Map<string, MediaStream>();

  constructor(private registry: InputRegistry) {
    for (const d of this.descriptors) {
      registry.upsert({
        id: d.id,
        kind: d.type === 'local-mic' ? 'audio' : 'video',
        type: d.type as InputType,
        label: d.label,
        origin: 'local',
        deviceId: 'local',
        deviceName: 'This computer',
        online: false,
      });
    }
  }

  has(id: string) {
    return this.descriptors.some((d) => d.id === id || `${d.id}:audio` === id);
  }

  async devices() {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  /** Re-open webcams/mics from last session when permission is already granted. */
  async restore() {
    const granted = async (name: string) => {
      try {
        return (await navigator.permissions.query({ name: name as PermissionName })).state === 'granted';
      } catch {
        return false;
      }
    };
    const cam = await granted('camera');
    const mic = await granted('microphone');
    for (const d of this.descriptors) {
      if ((d.type === 'webcam' && cam) || (d.type === 'local-mic' && mic)) {
        await this.open(d).catch((e) => console.warn('restore failed', d.label, e));
      }
    }
  }

  async addWebcam(deviceId?: string) {
    const d: LocalDescriptor = { id: uid('local:cam-'), type: 'webcam', deviceId, label: 'Webcam' };
    await this.open(d);
    this.add(d);
    return d.id;
  }

  async addMic(deviceId?: string) {
    const d: LocalDescriptor = { id: uid('local:mic-'), type: 'local-mic', deviceId, label: 'Microphone' };
    await this.open(d);
    this.add(d);
    return d.id;
  }

  async addScreen(surface: Surface) {
    const d: LocalDescriptor = {
      id: uid('local:screen-'),
      type: 'screen',
      surface,
      label: surface === 'browser' ? 'Browser tab' : surface === 'window' ? 'Window' : 'Screen',
    };
    await this.open(d);
    this.add(d);
    return d.id;
  }

  async reconnect(id: string) {
    const d = this.descriptors.find((x) => x.id === id || `${x.id}:audio` === id);
    if (d) await this.open(d);
  }

  remove(id: string) {
    const d = this.descriptors.find((x) => x.id === id || `${x.id}:audio` === id);
    if (!d) return;
    this.stop(d.id);
    this.descriptors = this.descriptors.filter((x) => x !== d);
    this.save();
    this.registry.remove(d.id);
    this.registry.remove(`${d.id}:audio`);
  }

  private add(d: LocalDescriptor) {
    this.descriptors.push(d);
    this.save();
  }

  private save() {
    saveJSON(STORAGE_KEY, this.descriptors);
  }

  private stop(id: string) {
    this.streams.get(id)?.getTracks().forEach((t) => t.stop());
    this.streams.delete(id);
  }

  private async open(d: LocalDescriptor) {
    this.stop(d.id);
    let stream: MediaStream;
    if (d.type === 'webcam') {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: d.deviceId ? { exact: d.deviceId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } else if (d.type === 'local-mic') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: d.deviceId ? { exact: d.deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: d.surface, frameRate: { ideal: 30 } } as MediaTrackConstraints,
        audio: true,
        // Chrome-specific hints; ignored elsewhere.
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
    }
    this.streams.set(d.id, stream);

    const v = stream.getVideoTracks()[0];
    const a = stream.getAudioTracks()[0];
    const primary = v ?? a;
    if (primary?.label && d.type !== 'screen') d.label = primary.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
    if (d.type === 'screen' && v) {
      const surface = (v.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
      d.label = surface === 'browser' ? 'Browser tab' : surface === 'window' ? 'Window capture' : 'Screen capture';
      if (v.label && !/^(screen|window|web-contents)/i.test(v.label)) d.label += ` · ${v.label}`;
      v.contentHint = 'detail';
    }
    this.save();

    const base = { origin: 'local' as const, deviceId: 'local', deviceName: 'This computer' };
    const track = d.type === 'local-mic' ? a : v;
    if (track) {
      this.registry.upsert({
        ...base,
        id: d.id,
        kind: d.type === 'local-mic' ? 'audio' : 'video',
        type: d.type as InputType,
        label: d.label,
        meta: { width: track.getSettings().width, height: track.getSettings().height },
      });
      this.registry.setStream(d.id, new MediaStream([track]));
      this.registry.setOnline(d.id, true);
      track.addEventListener('ended', () => this.registry.setOnline(d.id, false));
    }
    if (d.type === 'screen' && a) {
      const aid = `${d.id}:audio`;
      this.registry.upsert({ ...base, id: aid, kind: 'audio', type: 'screen-audio', label: `${d.label} audio` });
      this.registry.setStream(aid, new MediaStream([a]));
      this.registry.setOnline(aid, true);
      a.addEventListener('ended', () => this.registry.setOnline(aid, false));
    }
  }
}
