// Interactive scene editor overlay: select, move, resize (corner handles keep
// aspect ratio; hold Shift for free resize) and crop (hold Alt while dragging a
// handle) — the same gestures as OBS. Ctrl disables snapping.

import { clamp } from '../lib/util';
import type { Compositor } from './compositor';
import { SCENE_H, SCENE_W, type SceneItem, type SceneStore } from './scenes';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

interface Drag {
  mode: 'move' | 'resize' | 'crop';
  handle?: Handle;
  sx: number;
  sy: number;
  orig: SceneItem;
  pointerId: number;
}

export class Editor {
  readonly overlay = document.createElement('canvas');
  private octx = this.overlay.getContext('2d')!;
  private drag: Drag | null = null;
  /** Inline text editing on the canvas (double-click a text source). */
  private textEdit: { id: string; ta: HTMLTextAreaElement; original: string; stop: (commit: boolean) => void } | null = null;

  /** Open an in-place editor over a text source; click outside to finish, Esc to cancel. */
  startTextEdit(itemId: string) {
    this.textEdit?.stop(true);
    const it = this.store.editing.items.find((i) => i.id === itemId);
    if (!it || it.source.type !== 'text') return;
    const host = this.overlay.parentElement;
    if (!host) return;
    this.store.select(itemId);

    const ta = document.createElement('textarea');
    ta.className = 'canvas-text-edit';
    ta.value = it.source.text;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Edit text');
    host.append(ta);

    const original = it.source.text;
    const write = (text: string) => {
      const cur = this.store.editing.items.find((i) => i.id === itemId);
      if (cur && cur.source.type === 'text' && cur.source.text !== text) {
        this.store.updateItem(itemId, { source: { ...cur.source, text } });
      }
    };
    ta.addEventListener('input', () => write(ta.value));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger studio shortcuts
      if (e.key === 'Escape') {
        e.preventDefault();
        stop(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        stop(true);
      }
    });
    const onDown = (e: PointerEvent) => {
      if (e.target !== ta) stop(true);
    };
    document.addEventListener('pointerdown', onDown, true);

    const stop = (commit: boolean) => {
      if (this.textEdit?.ta !== ta) return;
      this.textEdit = null;
      document.removeEventListener('pointerdown', onDown, true);
      if (!commit) write(original);
      ta.remove();
      this.overlay.focus();
    };
    this.textEdit = { id: itemId, ta, original, stop };
    this.layoutTextEdit();
    ta.focus();
    ta.select();
  }

  /** Keep the inline text editor sized/styled to match the rendered text. */
  private layoutTextEdit() {
    const ed = this.textEdit;
    if (!ed) return;
    const it = this.store.editing.items.find((i) => i.id === ed.id);
    if (!it || it.source.type !== 'text') return ed.stop(true);
    const nat = this.comp.naturalSize(it);
    if (!nat || !nat.h) return;
    const s = this.overlay.getBoundingClientRect().width / SCENE_W; // CSS px per scene unit
    const px = (it.h / nat.h) * s; // CSS px per text-canvas px
    const src = it.source;
    const pad = src.bg ? src.size * 0.35 : src.outline + 4;
    Object.assign(ed.ta.style, {
      left: `${it.x * s}px`,
      top: `${it.y * s}px`,
      width: `${Math.max(it.w * s, 40)}px`,
      height: `${it.h * s}px`,
      padding: `${pad * px}px`,
      font: `${src.bold ? 700 : 400} ${src.size * px}px ${src.font}`,
      lineHeight: `${Math.round(src.size * 1.25) * px}px`,
      textAlign: src.align,
      // The canvas already draws the real text (it's also the live output), so the
      // edit box's own glyphs stay invisible; only its caret and selection show.
      color: 'transparent',
      background: 'transparent',
    });
  }
  private hoverId: string | null = null;
  private guides: { x?: number; y?: number } = {};

  constructor(
    private store: SceneStore,
    private comp: Compositor,
    private labelOf: (item: SceneItem) => string,
  ) {
    const o = this.overlay;
    o.className = 'editor-overlay';
    o.tabIndex = 0;
    o.addEventListener('pointerdown', (e) => this.onDown(e));
    o.addEventListener('pointermove', (e) => this.onMove(e));
    o.addEventListener('pointerup', (e) => this.onUp(e));
    o.addEventListener('pointercancel', (e) => this.onUp(e));
    o.addEventListener('pointerleave', () => (this.hoverId = null));
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    o.addEventListener('dblclick', (e) => {
      const it = this.itemAt(e.clientX, e.clientY);
      if (it?.source.type === 'text' && !it.locked) this.startTextEdit(it.id);
    });
    comp.onFrame(() => {
      this.draw();
      this.layoutTextEdit();
    });
  }

  /** Overlay pixels per scene unit. */
  private get k() {
    return this.overlay.getBoundingClientRect().width / SCENE_W || 1;
  }

  private toScene(e: PointerEvent) {
    const r = this.overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SCENE_W, y: ((e.clientY - r.top) / r.height) * SCENE_H };
  }

  private handlePoints(it: SceneItem): Record<Handle, [number, number]> {
    const { x, y, w, h } = it;
    return {
      nw: [x, y],
      n: [x + w / 2, y],
      ne: [x + w, y],
      e: [x + w, y + h / 2],
      se: [x + w, y + h],
      s: [x + w / 2, y + h],
      sw: [x, y + h],
      w: [x, y + h / 2],
    };
  }

  private hitHandle(it: SceneItem, p: { x: number; y: number }): Handle | null {
    const tol = 9 / this.k;
    const pts = this.handlePoints(it);
    for (const hd of HANDLES) {
      if (it.source.type === 'text' && (hd === 'e' || hd === 'w')) continue;
      const [hx, hy] = pts[hd];
      if (Math.abs(p.x - hx) <= tol && Math.abs(p.y - hy) <= tol) return hd;
    }
    return null;
  }

  /** Topmost visible scene item under a screen point (for right-click menus). */
  itemAt(clientX: number, clientY: number): SceneItem | null {
    const r = this.overlay.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return this.hitItem({ x: ((clientX - r.left) / r.width) * SCENE_W, y: ((clientY - r.top) / r.height) * SCENE_H });
  }

  private hitItem(p: { x: number; y: number }): SceneItem | null {
    const items = this.store.editing.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it.visible) continue;
      if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) return it;
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.overlay.focus();
    const p = this.toScene(e);
    const sel = this.store.selectedItem;
    if (sel && !sel.locked) {
      const hd = this.hitHandle(sel, p);
      if (hd) {
        this.beginDrag(e, e.altKey ? 'crop' : 'resize', sel, p, hd);
        return;
      }
    }
    const hit = this.hitItem(p);
    this.store.select(hit?.id ?? null);
    if (hit && !hit.locked) this.beginDrag(e, 'move', hit, p);
  }

  private beginDrag(e: PointerEvent, mode: Drag['mode'], item: SceneItem, p: { x: number; y: number }, handle?: Handle) {
    this.drag = { mode, handle, sx: p.x, sy: p.y, orig: structuredClone(item), pointerId: e.pointerId };
    this.overlay.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    const p = this.toScene(e);
    const d = this.drag;
    if (!d) {
      const sel = this.store.selectedItem;
      const hd = sel && !sel.locked ? this.hitHandle(sel, p) : null;
      const hit = this.hitItem(p);
      this.hoverId = hit?.id ?? null;
      this.overlay.style.cursor = hd ? CURSORS[hd] : hit && !hit.locked ? 'move' : 'default';
      return;
    }
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    const o = d.orig;
    const snap = !e.ctrlKey && !e.metaKey;
    this.guides = {};
    let patch: Partial<SceneItem> = {};

    if (d.mode === 'move') {
      let x = o.x + dx;
      let y = o.y + dy;
      if (snap) [x, y] = this.snapMove(x, y, o.w, o.h);
      patch = { x: Math.round(x), y: Math.round(y) };
    } else if (d.mode === 'resize' && d.handle) {
      if (o.source.type === 'text') {
        // Text scales by height only; its width always follows the text.
        if (d.handle === 'e' || d.handle === 'w') return;
        patch = this.resize(o, d.handle, dx, dy, true, snap);
        delete patch.w;
        if (d.handle.includes('w')) delete patch.x; // keep the left edge anchored
      } else {
        patch = this.resize(o, d.handle, dx, dy, !e.shiftKey, snap);
      }
    } else if (d.mode === 'crop' && d.handle) {
      patch = this.crop(o, d.handle, dx, dy);
    }
    this.store.updateItem(o.id, patch);
  }

  private onUp(e: PointerEvent) {
    if (this.drag?.pointerId === e.pointerId) {
      this.overlay.releasePointerCapture(e.pointerId);
      this.drag = null;
      this.guides = {};
    }
  }

  private snapMove(x: number, y: number, w: number, h: number): [number, number] {
    const tol = 12 / this.k;
    const xs: [number, number][] = [
      [0, 0],
      [SCENE_W / 2 - w / 2, SCENE_W / 2],
      [SCENE_W - w, SCENE_W],
    ];
    const ys: [number, number][] = [
      [0, 0],
      [SCENE_H / 2 - h / 2, SCENE_H / 2],
      [SCENE_H - h, SCENE_H],
    ];
    for (const [cand, guide] of xs)
      if (Math.abs(x - cand) < tol) {
        x = cand;
        this.guides.x = guide;
        break;
      }
    for (const [cand, guide] of ys)
      if (Math.abs(y - cand) < tol) {
        y = cand;
        this.guides.y = guide;
        break;
      }
    return [x, y];
  }

  private resize(o: SceneItem, hd: Handle, dx: number, dy: number, keepAspect: boolean, snap: boolean) {
    const tol = 12 / this.k;
    const snapEdge = (v: number, edges: number[]) => {
      if (!snap) return v;
      for (const e of edges) if (Math.abs(v - e) < tol) return e;
      return v;
    };
    let left = o.x;
    let top = o.y;
    let right = o.x + o.w;
    let bottom = o.y + o.h;
    if (hd.includes('w')) left = snapEdge(o.x + dx, [0, SCENE_W / 2]);
    if (hd.includes('e')) right = snapEdge(o.x + o.w + dx, [SCENE_W, SCENE_W / 2]);
    if (hd.includes('n')) top = snapEdge(o.y + dy, [0, SCENE_H / 2]);
    if (hd.includes('s')) bottom = snapEdge(o.y + o.h + dy, [SCENE_H, SCENE_H / 2]);

    const MIN = 8;
    let w = Math.max(MIN, right - left);
    let h = Math.max(MIN, bottom - top);
    if (keepAspect && hd.length === 2 && o.h > 0) {
      const ratio = o.w / o.h;
      if (w / h > ratio) h = w / ratio;
      else w = h * ratio;
    }
    const x = hd.includes('w') ? o.x + o.w - w : o.x;
    const y = hd.includes('n') ? o.y + o.h - h : o.y;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  private crop(o: SceneItem, hd: Handle, dx: number, dy: number): Partial<SceneItem> {
    const c = { ...o.crop };
    let { x, y, w, h } = o;
    const pxX = o.w / Math.max(0.02, 1 - c.l - c.r);
    const pxY = o.h / Math.max(0.02, 1 - c.t - c.b);
    if (hd.includes('w')) {
      const nl = clamp(c.l + dx / pxX, 0, 1 - c.r - 0.02);
      const moved = (nl - c.l) * pxX;
      x += moved;
      w -= moved;
      c.l = nl;
    }
    if (hd.includes('e')) {
      const nr = clamp(c.r - dx / pxX, 0, 1 - c.l - 0.02);
      w -= (nr - c.r) * pxX;
      c.r = nr;
    }
    if (hd.includes('n')) {
      const nt = clamp(c.t + dy / pxY, 0, 1 - c.b - 0.02);
      const moved = (nt - c.t) * pxY;
      y += moved;
      h -= moved;
      c.t = nt;
    }
    if (hd.includes('s')) {
      const nb = clamp(c.b - dy / pxY, 0, 1 - c.t - 0.02);
      h -= (nb - c.b) * pxY;
      c.b = nb;
    }
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), crop: c };
  }

  private draw() {
    const o = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const rect = o.getBoundingClientRect();
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    if (!pw || !ph) return;
    if (o.width !== pw || o.height !== ph) {
      o.width = pw;
      o.height = ph;
    }
    const c = this.octx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pw, ph);
    const s = pw / SCENE_W; // device px per scene unit
    c.setTransform(s, 0, 0, s, 0, 0);
    const u = dpr / s; // one CSS pixel in scene units

    const sel = this.store.selectedItem;
    for (const it of this.store.editing.items) {
      if (!it.visible) continue;
      const missing = it.source.type !== 'color' && !this.comp.drawableOf(it);
      if (missing) {
        c.save();
        c.fillStyle = 'rgba(40,44,54,0.55)';
        c.fillRect(it.x, it.y, it.w, it.h);
        c.setLineDash([6 * u, 4 * u]);
        c.strokeStyle = 'rgba(160,170,190,0.7)';
        c.lineWidth = u;
        c.strokeRect(it.x, it.y, it.w, it.h);
        c.setLineDash([]);
        c.fillStyle = 'rgba(200,206,218,0.9)';
        c.font = `${13 * u}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(`${this.labelOf(it)} (no signal)`, it.x + it.w / 2, it.y + it.h / 2);
        c.restore();
      }
      if (it.id === this.hoverId && it !== sel) {
        c.strokeStyle = 'rgba(76,141,255,0.9)';
        c.lineWidth = u;
        c.strokeRect(it.x, it.y, it.w, it.h);
      }
    }

    if (this.guides.x !== undefined || this.guides.y !== undefined) {
      c.strokeStyle = 'rgba(255,0,200,0.8)';
      c.lineWidth = u;
      c.beginPath();
      if (this.guides.x !== undefined) {
        c.moveTo(this.guides.x, 0);
        c.lineTo(this.guides.x, SCENE_H);
      }
      if (this.guides.y !== undefined) {
        c.moveTo(0, this.guides.y);
        c.lineTo(SCENE_W, this.guides.y);
      }
      c.stroke();
    }

    if (sel && sel.visible) {
      const { x, y, w, h, crop } = sel;
      c.lineWidth = 2 * u;
      const edge = (cropped: number, x1: number, y1: number, x2: number, y2: number) => {
        c.strokeStyle = cropped > 0 ? '#3ddc84' : sel.locked ? '#8b93a3' : '#e5484d';
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.stroke();
      };
      edge(crop.t, x, y, x + w, y);
      edge(crop.r, x + w, y, x + w, y + h);
      edge(crop.b, x, y + h, x + w, y + h);
      edge(crop.l, x, y, x, y + h);
      if (!sel.locked) {
        const hs = 8 * u;
        c.fillStyle = '#fff';
        c.strokeStyle = '#e5484d';
        c.lineWidth = 1.5 * u;
        for (const [hd, [hx, hy]] of Object.entries(this.handlePoints(sel))) {
          if (sel.source.type === 'text' && (hd === 'e' || hd === 'w')) continue;
          c.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
          c.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
        }
      }
      // size label
      const label = `${this.labelOf(sel)}  ${Math.round(w)}×${Math.round(h)}`;
      c.font = `${12 * u}px system-ui, sans-serif`;
      const tw = c.measureText(label).width + 10 * u;
      const ly = y > 22 * u ? y - 20 * u : y + 2 * u;
      c.fillStyle = 'rgba(229,72,77,0.92)';
      c.fillRect(x, ly, tw, 18 * u);
      c.fillStyle = '#fff';
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      c.fillText(label, x + 5 * u, ly + 9 * u);
    }
  }
}
