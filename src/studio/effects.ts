// Keying for video sources, on the GPU (WebGL2):
//
//  • Color key: per-pixel distance in chroma (CbCr) space from the key color,
//    so brightness changes and shadows on the screen don't matter. A 3×3
//    neighbourhood average cuts sensor noise at edges; a smooth ramp gives soft
//    edges; spill suppression desaturates key-colored light bouncing onto the
//    subject.
//
//  • Background removal: a MediaPipe person-segmentation model produces a
//    low-resolution "person" probability mask. Two refinements make it usable
//    for video: temporal smoothing (steady, no flicker) and an edge-aware
//    (joint bilateral) upsampling pass that snaps the mask's edges to the real
//    edges in the full-resolution frame.
//
// One shared WebGL2 context renders every keyed source in turn; the result is
// drawn into the compositor immediately, so a single canvas is enough.

import { basePath } from '../lib/room';
import { keyOf, type KeySettings, type SceneItem } from './scenes';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Flip Y so texture row 0 (top of the video) lands at the top of the canvas.
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const CHROMA_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec3 u_key;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;

// BT.709 chroma (Cb, Cr): color without brightness.
vec2 chroma(vec3 c) {
  return vec2(-0.1146 * c.r - 0.3854 * c.g + 0.5 * c.b,
               0.5 * c.r - 0.4542 * c.g - 0.0458 * c.b);
}

void main() {
  vec4 px = texture(u_tex, v_uv);
  vec2 k = chroma(u_key);
  float d = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      d += distance(chroma(texture(u_tex, v_uv + vec2(x, y) * u_texel).rgb), k);
  d /= 9.0;

  float base = d - u_similarity;
  float a = pow(clamp(base / max(u_smoothness, 1e-4), 0.0, 1.0), 1.5);
  float spill = pow(clamp(base / max(u_spill, 1e-4), 0.0, 1.0), 1.5);
  float luma = dot(px.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(luma), px.rgb, spill);
  o = vec4(rgb * a, a); // premultiplied
}`;

const MATTE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform vec2 u_maskTexel;
uniform float u_lo;
uniform float u_hi;
uniform float u_shift;
uniform float u_bgOpacity;
uniform sampler2D u_blur; // blurred background (premultiplied by blur weight), or unused
uniform float u_useBlur;
uniform vec2 u_feather; // feather radius in uv (x, y); 0 = off

void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  // Joint bilateral upsampling: average nearby mask values, weighting
  // neighbours whose video color matches this pixel. Mask edges follow the
  // real edges in the image instead of the coarse model grid.
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 off = vec2(x, y) * u_maskTexel * 0.75;
      vec3 dc = c - texture(u_tex, v_uv + off).rgb;
      float w = exp(-dot(dc, dc) * 40.0) * exp(-float(x * x + y * y) * 0.3);
      sum += texture(u_mask, v_uv + off).r * w;
      wsum += w;
    }
  }
  float m = sum / max(wsum, 1e-5);
  // Feather: average the mask over a disc (Vogel spiral) so the cut-out edge
  // fades out over a wider band instead of a hard line.
  if (u_feather.x > 0.0) {
    float disc = m;
    for (int i = 0; i < 24; i++) {
      float r = sqrt((float(i) + 0.5) / 24.0);
      float th = float(i) * 2.39996323;
      disc += texture(u_mask, v_uv + vec2(cos(th), sin(th)) * r * u_feather).r;
    }
    disc /= 25.0;
    m = mix(m, disc, 0.85);
  }
  m += u_shift;
  float person = smoothstep(u_lo, u_hi, m);
  // Background: optionally blurred (blur texture is stored flipped, see blur passes).
  vec3 bg = c;
  if (u_useBlur > 0.5) {
    vec4 b = texture(u_blur, vec2(v_uv.x, 1.0 - v_uv.y));
    if (b.a > 1e-3) bg = b.rgb / b.a;
  }
  vec3 rgb = mix(bg, c, person);
  // Background stays visible at u_bgOpacity instead of disappearing completely.
  float a = mix(u_bgOpacity, 1.0, person);
  o = vec4(rgb * a, a); // premultiplied
}`;

// Masked separable Gaussian blur of the background. Pixels the model thinks are
// the person get zero weight, so the person's colors don't bleed into the
// blurred background (no halo). Pass 1 (horizontal) reads the video + mask and
// writes weighted color + total weight; pass 2 (vertical) blurs that result.
const BLUR_H_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform vec2 u_step;   // offset between taps, in uv
uniform float u_sigma; // in taps
void main() {
  vec4 acc = vec4(0.0);
  float norm = 0.0;
  for (int i = -12; i <= 12; i++) {
    float g = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    vec2 uv = v_uv + float(i) * u_step;
    float bgw = 1.0 - smoothstep(0.3, 0.7, texture(u_mask, uv).r);
    float w = g * bgw;
    acc += vec4(texture(u_tex, uv).rgb * w, w);
    norm += g;
  }
  o = acc / max(norm, 1e-5);
}`;

const BLUR_V_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_step;
uniform float u_sigma;
void main() {
  vec2 base = vec2(v_uv.x, 1.0 - v_uv.y); // sample the (flipped) render target
  vec4 acc = vec4(0.0);
  float norm = 0.0;
  for (int i = -12; i <= 12; i++) {
    float g = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    acc += texture(u_src, base + float(i) * u_step) * g;
    norm += g;
  }
  o = acc / max(norm, 1e-5);
}`;

type Prog = { prog: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null };

interface MaskState {
  tex: WebGLTexture;
  buf: Float32Array | null; // temporally smoothed person probability
  bytes: Uint8Array | null;
  w: number;
  h: number;
  seq: number; // which shared raw mask was last blended in
  quality: KeySettings['quality'];
}

// ---------------------------------------------------------------- segmentation

const MODEL_FILES: Record<KeySettings['quality'], string> = {
  fast: 'selfie_segmenter_landscape.tflite',
  accurate: 'selfie_multiclass_256x256.tflite',
};

/**
 * Frames are shrunk to about the model's own input width before analysis.
 * MediaPipe returns the mask at the size of the image it was given, so a full
 * 1280×720 frame would mean ~1M mask values to smooth and upload every time.
 * The matte shader upsamples edge-aware, so nothing is lost.
 */
const SEG_WIDTH = 256;
function segSize(video: HTMLVideoElement) {
  const w = Math.min(SEG_WIDTH, video.videoWidth);
  return { w, h: Math.max(1, Math.round((w * video.videoHeight) / video.videoWidth)) };
}

/** Latest person-probability mask for one camera (shared by every source showing it). */
type RawMask = { data: Float32Array; w: number; h: number; seq: number };

/**
 * Main-thread segmenter: only used if the background worker can't start.
 * `sink` gets data that is valid during the call only.
 */
class Segmenter {
  private ts = 0;
  private constructor(
    private seg: import('@mediapipe/tasks-vision').ImageSegmenter,
    private maskIndex: number,
    readonly invert: boolean,
  ) {}

  static async create(quality: KeySettings['quality']) {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const base = `${basePath()}vendor/mediapipe/`;
    const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`);
    const seg = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: base + MODEL_FILES[quality], delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    // Fast model: one "selfie" mask = person. Accurate model: classes starting
    // with "background" → person = 1 − background. Read from the model itself.
    const labels = seg.getLabels().map((l) => l.toLowerCase());
    const bg = labels.indexOf('background');
    return bg >= 0 ? new Segmenter(seg, bg, true) : new Segmenter(seg, 0, false);
  }

  private small = document.createElement('canvas');

  run(video: HTMLVideoElement, sink: (data: Float32Array, w: number, h: number) => void) {
    const { w, h } = segSize(video);
    if (this.small.width !== w || this.small.height !== h) {
      this.small.width = w;
      this.small.height = h;
    }
    this.small.getContext('2d')!.drawImage(video, 0, 0, w, h);
    this.ts = Math.max(this.ts + 1, Math.floor(performance.now()));
    this.seg.segmentForVideo(this.small, this.ts, (res) => {
      const mask = res.confidenceMasks?.[this.maskIndex];
      if (mask) sink(mask.getAsFloat32Array(), mask.width, mask.height);
    });
  }
}

/**
 * Person segmentation for one model quality. Runs the model on a background
 * thread (Web Worker) so the studio's main thread only posts frames and
 * receives masks. One analysis per camera, shared by every source showing it
 * (e.g. the same camera in Preview and Program). Falls back to the main
 * thread at a lower rate if workers can't run the model.
 */
class SegmentationService {
  status: 'loading' | 'ready' | Error = 'loading';
  private worker: Worker | null = null;
  private fallback: Segmenter | null = null;
  private latest = new Map<string, RawMask>();
  private inflight = new Set<string>();
  private lastRequest = new Map<string, number>();
  private seq = 0;

  constructor(
    private quality: KeySettings['quality'],
    private onStatus: () => void,
  ) {
    const abs = (p: string) => new URL(`${basePath()}vendor/mediapipe/${p}`, location.href).href;
    try {
      const w = new Worker(new URL('./seg-worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e) => this.onWorker(e.data);
      w.onerror = () => this.useFallback(new Error('background worker failed to start'));
      w.postMessage({ type: 'init', wasmPath: abs('wasm'), modelPath: abs(MODEL_FILES[quality]) });
    } catch (e) {
      this.useFallback(e);
    }
  }

  /** Ask for a fresh mask for this camera (rate-limited; no-op while one is in progress). */
  request(key: string, video: HTMLVideoElement) {
    if (this.status !== 'ready' || !video.videoWidth) return;
    const now = performance.now();
    const minInterval = this.worker ? 33 : 66; // ~30/s off-thread, ~15/s on the main thread
    if (this.inflight.has(key) || now - (this.lastRequest.get(key) ?? 0) < minInterval) return;
    this.lastRequest.set(key, now);

    if (this.worker) {
      const worker = this.worker;
      this.inflight.add(key);
      const { w, h } = segSize(video);
      createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
        .then((bitmap) => worker.postMessage({ type: 'frame', key, bitmap }, [bitmap]))
        .catch(() => this.inflight.delete(key));
    } else if (this.fallback) {
      const fb = this.fallback;
      fb.run(video, (data, w, h) => this.store(key, data, w, h, fb.invert, true));
    }
  }

  latestFor(key: string) {
    return this.latest.get(key);
  }

  private onWorker(msg: { type: string; key?: string; w?: number; h?: number; data?: Float32Array | null; message?: string }) {
    if (msg.type === 'ready') {
      this.status = 'ready';
      this.onStatus();
    } else if (msg.type === 'error') {
      this.useFallback(new Error(msg.message));
    } else if (msg.type === 'mask' && msg.key) {
      this.inflight.delete(msg.key);
      if (msg.data && msg.w && msg.h) this.store(msg.key, msg.data, msg.w, msg.h, false, false);
    }
  }

  /** Keep the newest mask per camera. `copy` when the data is only valid during the call. */
  private store(key: string, data: Float32Array, w: number, h: number, invert: boolean, copy: boolean) {
    let entry = this.latest.get(key);
    if (copy || invert) {
      if (!entry || entry.data.length !== data.length) entry = { data: new Float32Array(data.length), w, h, seq: 0 };
      if (invert) for (let i = 0; i < data.length; i++) entry.data[i] = 1 - data[i];
      else entry.data.set(data);
    } else {
      entry = { data, w, h, seq: 0 }; // transferred from the worker: ours to keep
    }
    entry.w = w;
    entry.h = h;
    entry.seq = ++this.seq;
    this.latest.set(key, entry);
  }

  private useFallback(reason: unknown) {
    if (this.fallback || this.status instanceof Error) return;
    console.warn('[effects] background segmentation unavailable, using main thread', reason);
    this.worker?.terminate();
    this.worker = null;
    this.status = 'loading';
    this.onStatus();
    Segmenter.create(this.quality)
      .then((seg) => {
        this.fallback = seg;
        this.status = 'ready';
      })
      .catch((e: unknown) => {
        this.status = e instanceof Error ? e : new Error(String(e));
      })
      .finally(() => this.onStatus());
  }
}

// ---------------------------------------------------------------- effects

export class Effects {
  private canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null;
  private chroma: Prog | null = null;
  private matte: Prog | null = null;
  private blurH: Prog | null = null;
  private blurV: Prog | null = null;
  private videoTex: WebGLTexture | null = null;
  private masks = new Map<string, MaskState>();
  private services = new Map<KeySettings['quality'], SegmentationService>();
  /** Per-quality status for the UI ("Loading model…", errors). */
  private listeners = new Set<() => void>();

  constructor() {
    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!this.gl) {
      console.warn('[effects] WebGL2 unavailable: keying disabled');
      return;
    }
    const gl = this.gl;
    try {
      this.chroma = this.program(CHROMA_FRAG);
      this.matte = this.program(MATTE_FRAG);
      this.blurH = this.program(BLUR_H_FRAG);
      this.blurV = this.program(BLUR_V_FRAG);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.videoTex = this.texture();
    } catch (e) {
      // Never take the compositor down: just switch keying off.
      console.warn('[effects] GPU setup failed: keying disabled', e);
      this.gl = null;
    }
  }

  get supported() {
    return !!this.gl;
  }

  onStatus(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Human-readable state of background removal for the given quality. */
  status(quality: KeySettings['quality']): string | null {
    if (!this.gl) return 'Keying needs WebGL2, which this browser does not have.';
    const s = this.services.get(quality)?.status;
    if (s === 'loading') return 'Loading the background removal model…';
    if (s instanceof Error) return `Background removal failed to load: ${s.message}`;
    return null;
  }

  /**
   * Render a keyed version of `video` for this item. Returns a canvas (same
   * pixel size as the video, transparent where keyed) to draw instead of the
   * raw frame, or null to draw the frame unchanged.
   */
  apply(item: SceneItem, video: HTMLVideoElement): CanvasImageSource | null {
    const k = keyOf(item);
    const gl = this.gl;
    if (!gl || k.mode === 'none' || !video.videoWidth) return null;

    let mask: MaskState | null = null;
    if (k.mode === 'remove') {
      // One analysis per camera, shared by every source showing it.
      const cam = item.source.type === 'input' ? item.source.inputId : item.id;
      mask = this.updateMask(item.id, cam, video, k);
      if (!mask?.buf) return null; // model still loading: show the plain video meanwhile
    }

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    if (k.mode === 'color' && this.chroma) {
      const p = this.chroma;
      gl.useProgram(p.prog);
      gl.uniform1i(p.loc('u_tex'), 0);
      gl.uniform2f(p.loc('u_texel'), 1 / w, 1 / h);
      gl.uniform3fv(p.loc('u_key'), hexToRgb(k.color));
      gl.uniform1f(p.loc('u_similarity'), k.similarity / 100);
      gl.uniform1f(p.loc('u_smoothness'), k.smoothness / 100);
      gl.uniform1f(p.loc('u_spill'), k.spill / 100);
      this.draw(p);
    } else if (k.mode === 'remove' && mask && this.matte) {
      const useBlur = this.blurBackground(mask, k, w, h);
      const p = this.matte;
      gl.useProgram(p.prog);
      gl.uniform1i(p.loc('u_blur'), 2);
      gl.uniform1f(p.loc('u_useBlur'), useBlur ? 1 : 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mask.tex);
      gl.uniform1i(p.loc('u_tex'), 0);
      gl.uniform1i(p.loc('u_mask'), 1);
      gl.uniform2f(p.loc('u_maskTexel'), 1 / mask.w, 1 / mask.h);
      const t = k.threshold / 100;
      const soft = Math.max(0.005, (k.softness / 100) * 0.5);
      gl.uniform1f(p.loc('u_lo'), t - soft);
      gl.uniform1f(p.loc('u_hi'), t + soft);
      gl.uniform1f(p.loc('u_shift'), k.shift / 100);
      gl.uniform1f(p.loc('u_bgOpacity'), Math.max(0, Math.min(1, k.bgOpacity / 100)));
      const featherPx = (k.feather / 100) * 30; // up to ~30 px at full resolution
      gl.uniform2f(p.loc('u_feather'), featherPx / w, featherPx / h);
      this.draw(p);
    }
    return this.canvas;
  }

  /**
   * Blur the background (person excluded) into a half-resolution texture bound
   * to texture unit 2. Returns false when blur is off or unavailable.
   * Leaves the default framebuffer bound with the full-size viewport.
   */
  private blurBackground(mask: MaskState, k: KeySettings, w: number, h: number): boolean {
    const gl = this.gl!;
    if (k.bgBlur <= 0 || k.bgOpacity <= 0 || !this.blurH || !this.blurV) return false;
    const bw = Math.max(1, Math.round(w / 2));
    const bh = Math.max(1, Math.round(h / 2));
    const t = this.ensureTargets(bw, bh);

    // Blur strength: up to ~48 px at full resolution (24 px at half res).
    const sigmaPx = Math.max(0.5, (k.bgBlur / 100) * 24);
    const spacing = Math.max(1, sigmaPx / 5); // 25 taps cover about ±2.4 sigma
    const sigmaTaps = sigmaPx / spacing;

    // Pass 1: horizontal, video + mask → A
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.a.fb);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.blurH.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.uniform1i(this.blurH.loc('u_tex'), 0);
    gl.uniform1i(this.blurH.loc('u_mask'), 1);
    gl.uniform2f(this.blurH.loc('u_step'), spacing / bw, 0);
    gl.uniform1f(this.blurH.loc('u_sigma'), sigmaTaps);
    this.draw(this.blurH);

    // Pass 2: vertical, A → B
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.b.fb);
    gl.useProgram(this.blurV.prog);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, t.a.tex);
    gl.uniform1i(this.blurV.loc('u_src'), 2);
    gl.uniform2f(this.blurV.loc('u_step'), 0, spacing / bh);
    gl.uniform1f(this.blurV.loc('u_sigma'), sigmaTaps);
    this.draw(this.blurV);

    // Back to the canvas; leave the blurred result on unit 2 for the final pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, t.b.tex);
    return true;
  }

  private targets: { w: number; h: number; a: { fb: WebGLFramebuffer; tex: WebGLTexture }; b: { fb: WebGLFramebuffer; tex: WebGLTexture } } | null =
    null;

  private ensureTargets(w: number, h: number) {
    const gl = this.gl!;
    if (this.targets && this.targets.w === w && this.targets.h === h) return this.targets;
    if (this.targets) {
      for (const t of [this.targets.a, this.targets.b]) {
        gl.deleteFramebuffer(t.fb);
        gl.deleteTexture(t.tex);
      }
    }
    // Create on a spare texture unit so the video (unit 0) and mask (unit 1) stay bound.
    gl.activeTexture(gl.TEXTURE3);
    const make = () => {
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex };
    };
    this.targets = { w, h, a: make(), b: make() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.targets;
  }

  /** Forget per-item state (item deleted). */
  release(itemId: string) {
    const m = this.masks.get(itemId);
    if (m && this.gl) this.gl.deleteTexture(m.tex);
    this.masks.delete(itemId);
  }

  // ---------------------------------------------------------------- internals

  private updateMask(itemId: string, cam: string, video: HTMLVideoElement, k: KeySettings): MaskState | null {
    const gl = this.gl!;
    const svc = this.serviceFor(k.quality);
    let st = this.masks.get(itemId);
    if (!st) {
      st = { tex: this.texture(), buf: null, bytes: null, w: 1, h: 1, seq: 0, quality: k.quality };
      this.masks.set(itemId, st);
    }
    if (st.quality !== k.quality) {
      st.quality = k.quality;
      st.buf = null; // different model resolution: start fresh
      st.seq = 0;
    }

    svc.request(cam, video); // rate-limited and de-duplicated per camera
    const raw = svc.latestFor(cam);
    if (!raw || raw.seq === st.seq) return st; // nothing new: reuse the uploaded mask
    st.seq = raw.seq;

    const { data, w, h } = raw;
    if (!st.buf || st.w !== w || st.h !== h) {
      st.buf = new Float32Array(data);
      st.bytes = new Uint8Array(w * h);
      st.w = w;
      st.h = h;
    } else {
      // Exponential moving average: higher smoothing = steadier mask.
      const a = 1 - Math.min(0.95, Math.max(0, k.smoothing / 100));
      const buf = st.buf;
      for (let i = 0; i < buf.length; i++) buf[i] += (data[i] - buf[i]) * a;
    }
    const buf = st.buf;
    const bytes = st.bytes!;
    for (let i = 0; i < buf.length; i++) bytes[i] = buf[i] <= 0 ? 0 : buf[i] >= 1 ? 255 : buf[i] * 255;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, st.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    gl.activeTexture(gl.TEXTURE0);
    return st;
  }

  private serviceFor(quality: KeySettings['quality']): SegmentationService {
    let svc = this.services.get(quality);
    if (!svc) {
      svc = new SegmentationService(quality, () => this.emit());
      this.services.set(quality, svc);
      this.emit();
    }
    return svc;
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private draw(p: Prog) {
    const gl = this.gl!;
    const loc = gl.getAttribLocation(p.prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private texture() {
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private program(frag: string): Prog {
    const gl = this.gl!;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    const cache = new Map<string, WebGLUniformLocation | null>();
    return {
      prog,
      loc: (name) => {
        if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
        return cache.get(name)!;
      },
    };
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x00ff00;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
