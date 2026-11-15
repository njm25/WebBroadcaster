// Records the composed program (canvas video + mixer audio) with MediaRecorder.
// Optionally streams straight to a file on disk (File System Access API) so
// long recordings don't accumulate in memory.

import { Emitter } from '../lib/emitter';

export interface Recording {
  name: string;
  url: string | null; // null when written directly to disk
  size: number;
  duration: number;
  mime: string;
}

export interface FormatOption {
  id: string;
  label: string;
  mime: string;
  ext: string;
}

const CANDIDATES: FormatOption[] = [
  { id: 'mp4', label: 'MP4 (H.264 / AAC)', mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
  { id: 'mp4-basic', label: 'MP4', mime: 'video/mp4', ext: 'mp4' },
  { id: 'webm-vp9', label: 'WebM (VP9 / Opus)', mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { id: 'webm-vp8', label: 'WebM (VP8 / Opus)', mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { id: 'webm', label: 'WebM', mime: 'video/webm', ext: 'webm' },
];

export function supportedFormats(): FormatOption[] {
  if (typeof MediaRecorder === 'undefined') return [];
  const list = CANDIDATES.filter((f) => MediaRecorder.isTypeSupported(f.mime));
  // Only offer the generic MP4 entry if the explicit codec string isn't supported.
  return list.filter((f) => !(f.id === 'mp4-basic' && list.some((x) => x.id === 'mp4')));
}

type Writable = { write(data: Blob): Promise<void>; close(): Promise<void> };

export class Recorder extends Emitter<{ state: []; saved: [Recording] }> {
  recordings: Recording[] = [];
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private writable: Writable | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  bytes = 0;
  error: string | null = null;

  get state(): RecordingState {
    return this.mr?.state ?? 'inactive';
  }

  get elapsed() {
    if (!this.mr) return 0;
    const now = this.mr.state === 'paused' ? this.pausedAt : performance.now();
    return now - this.startedAt - this.pausedTotal;
  }

  static canWriteToDisk() {
    return typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
  }

  /** Must be called from a user gesture when toDisk is true. */
  async start(stream: MediaStream, opts: { format: FormatOption; videoBitrate: number; toDisk: boolean }) {
    if (this.mr) return;
    this.error = null;
    const name = `WebBroadcaster_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${opts.format.ext}`;

    if (opts.toDisk && Recorder.canWriteToDisk()) {
      try {
        const picker = (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<{ createWritable(): Promise<Writable> }> })
          .showSaveFilePicker;
        const handle = await picker({
          suggestedName: name,
          types: [{ description: 'Video', accept: { [opts.format.mime.split(';')[0]]: [`.${opts.format.ext}`] } }],
        });
        this.writable = await handle.createWritable();
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return; // user cancelled
        throw e;
      }
    }

    const mr = new MediaRecorder(stream, {
      mimeType: opts.format.mime,
      videoBitsPerSecond: opts.videoBitrate,
      audioBitsPerSecond: 192_000,
    });
    this.mr = mr;
    this.chunks = [];
    this.bytes = 0;
    this.pausedTotal = 0;
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.bytes += e.data.size;
      if (this.writable) {
        const w = this.writable;
        this.writeChain = this.writeChain.then(() => w.write(e.data));
      } else this.chunks.push(e.data);
      this.emit('state');
    };
    mr.onerror = (e) => {
      this.error = String((e as unknown as { error?: Error }).error?.message ?? 'Recorder error');
      this.emit('state');
    };
    mr.onstop = async () => {
      const duration = this.elapsed;
      const mime = mr.mimeType || opts.format.mime;
      let rec: Recording;
      if (this.writable) {
        await this.writeChain;
        await this.writable.close();
        rec = { name, url: null, size: this.bytes, duration, mime };
      } else {
        const blob = new Blob(this.chunks, { type: mime.split(';')[0] });
        rec = { name, url: URL.createObjectURL(blob), size: blob.size, duration, mime };
      }
      this.writable = null;
      this.writeChain = Promise.resolve();
      this.chunks = [];
      this.mr = null;
      this.recordings.unshift(rec);
      this.emit('saved', rec);
      this.emit('state');
    };
    mr.start(1000);
    this.startedAt = performance.now();
    this.emit('state');
  }

  stop() {
    if (this.mr && this.mr.state !== 'inactive') this.mr.stop();
  }

  togglePause() {
    if (!this.mr) return;
    if (this.mr.state === 'recording') {
      this.mr.pause();
      this.pausedAt = performance.now();
    } else if (this.mr.state === 'paused') {
      this.pausedTotal += performance.now() - this.pausedAt;
      this.mr.resume();
    }
    this.emit('state');
  }
}
