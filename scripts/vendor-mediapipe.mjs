// Copies MediaPipe's WebAssembly runtime and downloads the segmentation
// models into public/vendor/mediapipe/, so background removal is served by
// this app (works offline in local mode; no runtime calls to Google).
// Runs automatically before `npm run dev` / `npm run build` (see package.json).
// Models: Apache-2.0, https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const out = path.join(root, 'public', 'vendor', 'mediapipe');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmOut = path.join(out, 'wasm');

const MODELS = {
  'selfie_segmenter_landscape.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

fs.mkdirSync(wasmOut, { recursive: true });

// 1) WebAssembly runtime (always refreshed so it matches the installed version)
for (const f of fs.readdirSync(wasmSrc)) {
  fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmOut, f));
}

// 2) Models (downloaded once, then cached)
let failed = false;
for (const [name, url] of Object.entries(MODELS)) {
  const dest = path.join(out, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`[vendor] downloaded ${name}`);
  } catch (e) {
    failed = true;
    console.warn(`[vendor] could not download ${name}: ${e.message}. Background removal needs it; re-run with internet access.`);
  }
}
if (!failed) console.log('[vendor] MediaPipe runtime and models ready');
