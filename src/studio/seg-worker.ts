/// <reference lib="webworker" />
// Background-thread person segmentation (MediaPipe). Runs the AI model off the
// studio's main thread so drawing, editing and input stay smooth.
//
// Messages in:  { type: 'init', wasmPath, modelPath }
//               { type: 'frame', key, bitmap }       (bitmap is transferred)
// Messages out: { type: 'ready' } | { type: 'error', message }
//               { type: 'mask', key, w, h, data }    (person probability 0–1, buffer transferred)

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

declare const self: DedicatedWorkerGlobalScope;

let seg: ImageSegmenter | null = null;
let maskIndex = 0;
let invert = false;
let ts = 0;

async function init(wasmPath: string, modelPath: string) {
  // Module workers need MediaPipe's "module" runtime variant (2nd argument).
  const fileset = await FilesetResolver.forVisionTasks(wasmPath, true);
  const make = (delegate: 'GPU' | 'CPU') =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
      canvas: new OffscreenCanvas(1, 1),
    });
  try {
    seg = await make('GPU');
  } catch {
    seg = await make('CPU'); // no WebGL in workers on this machine
  }
  // "selfie" model: mask 0 = person. Multiclass model: starts with "background".
  const labels = seg.getLabels().map((l) => l.toLowerCase());
  const bg = labels.indexOf('background');
  maskIndex = bg >= 0 ? bg : 0;
  invert = bg >= 0;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      await init(msg.wasmPath, msg.modelPath);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === 'frame') {
    const bitmap: ImageBitmap = msg.bitmap;
    if (!seg) {
      bitmap.close();
      self.postMessage({ type: 'mask', key: msg.key, w: 0, h: 0, data: null });
      return;
    }
    let out: Float32Array | null = null;
    let w = 0;
    let h = 0;
    try {
      ts = Math.max(ts + 1, Math.floor(performance.now()));
      seg.segmentForVideo(bitmap, ts, (res) => {
        const m = res.confidenceMasks?.[maskIndex];
        if (!m) return;
        const d = m.getAsFloat32Array();
        out = new Float32Array(d.length);
        if (invert) for (let i = 0; i < d.length; i++) out[i] = 1 - d[i];
        else out.set(d);
        w = m.width;
        h = m.height;
      });
    } catch (err) {
      console.warn('[seg-worker] segmentation failed', err);
    } finally {
      bitmap.close();
    }
    const data = out as Float32Array | null;
    self.postMessage({ type: 'mask', key: msg.key, w, h, data }, data ? [data.buffer] : []);
  }
};
