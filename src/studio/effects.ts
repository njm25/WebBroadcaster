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
  float m = sum / max(wsum, 1e-5) + u_shift;
  float a = smoothstep(u_lo, u_hi, m);
  o = vec4(c * a, a); // premultiplied
}`;

type Prog = { prog: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null };

interface MaskState {
  tex: WebGLTexture;
  buf: Float32Array | null; // temporally smoothed person probability
  bytes: Uint8Array | null;
  w: number;
  h: number;
  lastRun: number;
  quality: KeySettings['quality'];
}

// ---------------------------------------------------------------- segmentation

const MODEL_FILES: Record<KeySettings['quality'], string> = {
  fast: 'selfie_segmenter_landscape.tflite',
  accurate: 'selfie_multiclass_256x256.tflite',
};

type MaskSink = (data: Float32Array, w: number, h: number) => void;

class Segmenter {
  private ts = 0;
  private constructor(
    private seg: import('@mediapipe/tasks-vision').ImageSegmenter,
    private maskIndex: number,
    private invert: boolean,
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

  /** Run on the current video frame; `sink` receives person probability (0–1). */
  run(video: HTMLVideoElement, sink: MaskSink) {
    // VIDEO mode needs strictly increasing timestamps across all calls.
    this.ts = Math.max(this.ts + 1, Math.floor(performance.now()));
    this.seg.segmentForVideo(video, this.ts, (res) => {
      const mask = res.confidenceMasks?.[this.maskIndex];
      if (!mask) return;
      const data = mask.getAsFloat32Array();
      if (this.invert) {
        const out = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) out[i] = 1 - data[i];
        sink(out, mask.width, mask.height);
      } else {
        sink(data, mask.width, mask.height);
      }
    });
  }
}

// ---------------------------------------------------------------- effects

export class Effects {
  private canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null;
  private chroma: Prog | null = null;
  private matte: Prog | null = null;
  private videoTex: WebGLTexture | null = null;
  private masks = new Map<string, MaskState>();
  private segmenters = new Map<KeySettings['quality'], Segmenter | 'loading' | Error>();
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
    const s = this.segmenters.get(quality);
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
      mask = this.updateMask(item.id, video, k);
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
      const p = this.matte;
      gl.useProgram(p.prog);
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
      this.draw(p);
    }
    return this.canvas;
  }

  /** Forget per-item state (item deleted). */
  release(itemId: string) {
    const m = this.masks.get(itemId);
    if (m && this.gl) this.gl.deleteTexture(m.tex);
    this.masks.delete(itemId);
  }

  // ---------------------------------------------------------------- internals

  private updateMask(itemId: string, video: HTMLVideoElement, k: KeySettings): MaskState | null {
    const gl = this.gl!;
    const seg = this.segmenterFor(k.quality);
    let st = this.masks.get(itemId);
    if (!st) {
      st = { tex: this.texture(), buf: null, bytes: null, w: 1, h: 1, lastRun: 0, quality: k.quality };
      this.masks.set(itemId, st);
    }
    if (st.quality !== k.quality) {
      st.quality = k.quality;
      st.buf = null; // different model resolution: start fresh
    }
    if (!seg) return st;

    // Segment at most ~30 times a second per source.
    const now = performance.now();
    if (now - st.lastRun < 30) return st;
    st.lastRun = now;

    const s = st;
    seg.run(video, (data, w, h) => {
      if (!s.buf || s.w !== w || s.h !== h) {
        s.buf = new Float32Array(data);
        s.bytes = new Uint8Array(w * h);
        s.w = w;
        s.h = h;
      } else {
        // Exponential moving average: higher smoothing = steadier mask.
        const a = 1 - Math.min(0.95, Math.max(0, k.smoothing / 100));
        for (let i = 0; i < data.length; i++) s.buf[i] += (data[i] - s.buf[i]) * a;
      }
      const bytes = s.bytes!;
      for (let i = 0; i < s.buf.length; i++) bytes[i] = Math.max(0, Math.min(255, s.buf[i] * 255));
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    });
    return st;
  }

  private segmenterFor(quality: KeySettings['quality']): Segmenter | null {
    const s = this.segmenters.get(quality);
    if (s instanceof Segmenter) return s;
    if (s === undefined) {
      this.segmenters.set(quality, 'loading');
      this.emit();
      Segmenter.create(quality)
        .then((seg) => this.segmenters.set(quality, seg))
        .catch((e: unknown) => {
          console.warn('[effects] segmenter failed', e);
          this.segmenters.set(quality, e instanceof Error ? e : new Error(String(e)));
        })
        .finally(() => this.emit());
    }
    return null;
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
