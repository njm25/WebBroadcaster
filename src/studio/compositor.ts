// Canvas compositor: renders the program scene (with transitions) to the
// output canvas every frame, plus the preview scene in studio mode.
//
// Frames are driven by a Worker timer instead of requestAnimationFrame so
// rendering — and therefore recording — keeps going when the tab is hidden.

import { assets } from '../lib/util';
import { videoFrameOf, type InputRegistry } from './inputs';
import { SCENE_H, SCENE_W, type Scene, type SceneItem, type SceneStore, type TextStyle, type TransitionType } from './scenes';

interface Drawable {
  img: CanvasImageSource;
  w: number;
  h: number;
}

interface ActiveTransition {
  from: string;
  to: string;
  type: TransitionType;
  start: number;
  duration: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  readonly previewCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pctx: CanvasRenderingContext2D;
  private bufA = document.createElement('canvas');
  private bufB = document.createElement('canvas');
  private transition: ActiveTransition | null = null;
  private images = new Map<string, HTMLImageElement | 'loading' | 'error'>();
  private textCache = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private worker: Worker | null = null;
  private frameListeners = new Set<() => void>();
  fps = 30;
  /** Measured render rate. */
  actualFps = 0;
  private frameCount = 0;
  private fpsWindow = performance.now();

  constructor(
    private store: SceneStore,
    private registry: InputRegistry,
  ) {
    this.canvas = document.createElement('canvas');
    this.previewCanvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.pctx = this.previewCanvas.getContext('2d', { alpha: false })!;
    this.setOutput(1920, 1080, 30);
    store.on('program', (from, to) => this.startTransition(from, to));
  }

  get width() {
    return this.canvas.width;
  }
  get height() {
    return this.canvas.height;
  }
  get transitioning() {
    return !!this.transition;
  }

  setOutput(width: number, height: number, fps: number) {
    for (const c of [this.canvas, this.bufA, this.bufB]) {
      c.width = width;
      c.height = height;
    }
    this.previewCanvas.width = Math.min(width, 1280);
    this.previewCanvas.height = Math.round((this.previewCanvas.width * height) / width);
    this.fps = fps;
    this.start();
  }

  onFrame(fn: () => void) {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  private start() {
    this.worker?.terminate();
    const src = `let t;onmessage=e=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}`;
    this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    this.worker.onmessage = () => this.render();
    this.worker.postMessage(1000 / this.fps);
  }

  private startTransition(from: string, to: string) {
    const type = this.store.transition;
    if (type === 'cut' || this.store.duration <= 0) {
      this.transition = null;
      return;
    }
    this.transition = { from, to, type, start: performance.now(), duration: this.store.duration };
  }

  private render() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const tr = this.transition;
    let t = 1;
    if (tr) {
      t = Math.min(1, (performance.now() - tr.start) / tr.duration);
      if (t >= 1 || !this.store.find(tr.from)) this.transition = null;
    }

    this.syncTextBoxes();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (this.transition && tr) {
      const e = ease(t);
      const from = this.store.find(tr.from);
      const to = this.store.find(tr.to);
      this.drawSceneTo(this.bufA, from);
      this.drawSceneTo(this.bufB, to);
      switch (tr.type) {
        case 'fade':
          ctx.drawImage(this.bufA, 0, 0);
          ctx.globalAlpha = e;
          ctx.drawImage(this.bufB, 0, 0);
          break;
        case 'slide':
          ctx.drawImage(this.bufA, -e * W, 0);
          ctx.drawImage(this.bufB, (1 - e) * W, 0);
          break;
        case 'dip':
          if (t < 0.5) {
            ctx.globalAlpha = 1 - ease(t * 2);
            ctx.drawImage(this.bufA, 0, 0);
          } else {
            ctx.globalAlpha = ease(t * 2 - 1);
            ctx.drawImage(this.bufB, 0, 0);
          }
          break;
        default:
          ctx.drawImage(this.bufB, 0, 0);
      }
      ctx.globalAlpha = 1;
    } else {
      this.drawScene(ctx, this.store.program, W / SCENE_W);
    }

    if (this.store.studioMode) {
      const p = this.previewCanvas;
      this.pctx.fillStyle = '#000';
      this.pctx.fillRect(0, 0, p.width, p.height);
      this.drawScene(this.pctx, this.store.find(this.store.previewId), p.width / SCENE_W);
    }

    this.frameCount++;
    const now = performance.now();
    if (now - this.fpsWindow >= 1000) {
      this.actualFps = Math.round((this.frameCount * 1000) / (now - this.fpsWindow));
      this.frameCount = 0;
      this.fpsWindow = now;
    }
    for (const fn of this.frameListeners) fn();
  }

  /**
   * Text items scale by height only: the box height sets the text size and the
   * width always follows the text (so typing more makes the box longer instead
   * of squeezing the letters). Left edge stays put.
   */
  private syncTextBoxes() {
    let changed = false;
    for (const scene of this.store.scenes) {
      for (const it of scene.items) {
        if (it.source.type !== 'text' || it.h <= 0) continue;
        const c = this.textCanvas(it.id, it.source);
        const { l, t, r, b } = it.crop;
        const srcW = c.width * Math.max(0.02, 1 - l - r);
        const srcH = c.height * Math.max(0.02, 1 - t - b);
        const w = Math.max(1, Math.round((srcW * it.h) / srcH));
        if (Math.abs(w - it.w) > 1 || it.fit !== 'stretch') {
          it.w = w;
          it.fit = 'stretch'; // box now matches the text's aspect exactly
          changed = true;
        }
      }
    }
    if (changed) this.store.changed();
  }

  private drawSceneTo(buf: HTMLCanvasElement, scene: Scene | undefined) {
    const c = buf.getContext('2d')!;
    c.globalAlpha = 1;
    c.fillStyle = '#000';
    c.fillRect(0, 0, buf.width, buf.height);
    this.drawScene(c, scene, buf.width / SCENE_W);
  }

  drawScene(ctx: CanvasRenderingContext2D, scene: Scene | undefined, scale: number) {
    if (!scene) return;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.imageSmoothingQuality = 'high';
    for (const item of scene.items) this.drawItem(ctx, item);
    ctx.restore();
  }

  private drawItem(ctx: CanvasRenderingContext2D, item: SceneItem) {
    if (!item.visible || item.w <= 0 || item.h <= 0) return;
    ctx.save();
    ctx.globalAlpha = item.opacity;
    if (item.radius > 0) {
      ctx.beginPath();
      ctx.roundRect(item.x, item.y, item.w, item.h, item.radius);
      ctx.clip();
    }
    if (item.source.type === 'color') {
      ctx.fillStyle = item.source.color;
      ctx.fillRect(item.x, item.y, item.w, item.h);
      ctx.restore();
      return;
    }
    const d = this.drawableOf(item);
    if (d) {
      const { l, t, r, b } = item.crop;
      let sx = d.w * l;
      let sy = d.h * t;
      let sw = d.w * (1 - l - r);
      let sh = d.h * (1 - t - b);
      if (sw >= 1 && sh >= 1) {
        let dx = item.x;
        let dy = item.y;
        let dw = item.w;
        let dh = item.h;
        if (item.fit === 'contain') {
          const s = Math.min(item.w / sw, item.h / sh);
          dw = sw * s;
          dh = sh * s;
          dx = item.x + (item.w - dw) / 2;
          dy = item.y + (item.h - dh) / 2;
        } else if (item.fit === 'cover') {
          const ba = item.w / item.h;
          if (sw / sh > ba) {
            const nsw = sh * ba;
            sx += (sw - nsw) / 2;
            sw = nsw;
          } else {
            const nsh = sw / ba;
            sy += (sh - nsh) / 2;
            sh = nsh;
          }
        }
        if (item.flipH) {
          ctx.translate(dx * 2 + dw, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(d.img, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    }
    ctx.restore();
  }

  /** Native pixel size of an item's source, if known. */
  naturalSize(item: SceneItem): { w: number; h: number } | null {
    if (item.source.type === 'color') return { w: item.w, h: item.h };
    const d = this.drawableOf(item);
    return d ? { w: d.w, h: d.h } : null;
  }

  drawableOf(item: SceneItem): Drawable | null {
    const src = item.source;
    switch (src.type) {
      case 'input': {
        const v = videoFrameOf(this.registry.get(src.inputId));
        return v ? { img: v, w: v.videoWidth, h: v.videoHeight } : null;
      }
      case 'image': {
        const img = this.images.get(src.assetId);
        if (img === undefined) this.loadImage(src.assetId);
        return img instanceof HTMLImageElement ? { img, w: img.naturalWidth, h: img.naturalHeight } : null;
      }
      case 'text': {
        const c = this.textCanvas(item.id, src);
        return { img: c, w: c.width, h: c.height };
      }
      default:
        return null;
    }
  }

  private loadImage(assetId: string) {
    this.images.set(assetId, 'loading');
    assets
      .get(assetId)
      .then((blob) => {
        if (!blob) throw new Error('missing asset');
        const img = new Image();
        img.onload = () => this.images.set(assetId, img);
        img.onerror = () => this.images.set(assetId, 'error');
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => this.images.set(assetId, 'error'));
  }

  private textCanvas(itemId: string, s: TextStyle): HTMLCanvasElement {
    const key = JSON.stringify([s.text, s.font, s.size, s.color, s.bold, s.bg, s.align, s.outline]);
    const cached = this.textCache.get(itemId);
    if (cached?.key === key) return cached.canvas;
    const canvas = cached?.canvas ?? document.createElement('canvas');
    const c = canvas.getContext('2d')!;
    const font = `${s.bold ? 700 : 400} ${s.size}px ${s.font}`;
    c.font = font;
    const lines = (s.text || ' ').split('\n');
    const lineH = Math.round(s.size * 1.25);
    const pad = Math.round(s.bg ? s.size * 0.35 : s.outline + 4);
    const widths = lines.map((l) => c.measureText(l).width);
    canvas.width = Math.max(1, Math.ceil(Math.max(...widths) + pad * 2));
    canvas.height = Math.max(1, Math.ceil(lines.length * lineH + pad * 2));
    c.font = font;
    c.textBaseline = 'middle';
    if (s.bg) {
      c.fillStyle = s.bg;
      c.fillRect(0, 0, canvas.width, canvas.height);
    }
    lines.forEach((line, i) => {
      const w = widths[i];
      const x = s.align === 'left' ? pad : s.align === 'right' ? canvas.width - pad - w : (canvas.width - w) / 2;
      const y = pad + lineH * i + lineH / 2;
      if (s.outline > 0) {
        c.lineJoin = 'round';
        c.lineWidth = s.outline * 2;
        c.strokeStyle = '#000';
        c.strokeText(line, x, y);
      }
      c.fillStyle = s.color;
      c.fillText(line, x, y);
    });
    this.textCache.set(itemId, { key, canvas });
    return canvas;
  }
}
