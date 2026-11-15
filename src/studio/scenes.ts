// Scene model. Coordinates are in a fixed 1920x1080 "scene space"; the
// compositor scales to whatever output resolution is configured.

import { Emitter } from '../lib/emitter';
import { loadJSON, saveJSON, uid } from '../lib/util';

export const SCENE_W = 1920;
export const SCENE_H = 1080;

export type TextStyle = {
  text: string;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  bg: string; // '' = transparent
  align: 'left' | 'center' | 'right';
  outline: number;
};

export type ItemSource =
  | { type: 'input'; inputId: string }
  | { type: 'image'; assetId: string; name: string }
  | ({ type: 'text' } & TextStyle)
  | { type: 'color'; color: string };

export type Fit = 'contain' | 'cover' | 'stretch';

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
} // fractions 0..1 of the source

export interface SceneItem {
  id: string;
  name: string;
  source: ItemSource;
  x: number;
  y: number;
  w: number;
  h: number;
  crop: Crop;
  fit: Fit;
  flipH: boolean;
  opacity: number;
  radius: number;
  visible: boolean;
  locked: boolean;
  /** Re-fit the box when the source flips between portrait and landscape. */
  autoFit: boolean;
  /** Keying for video sources (color key or AI background removal). */
  key?: KeySettings;
}

export type KeyMode = 'none' | 'color' | 'remove';

/** All values are UI units (mostly 0–100) so they're easy to show and store. */
export interface KeySettings {
  mode: KeyMode;
  // Color key
  color: string; // hex, e.g. #00ff00
  similarity: number; // 0–100: how far from the key color still counts as "key"
  smoothness: number; // 0–100: softness of the transition at the edge
  spill: number; // 0–100: how much key-colored tint to remove from what's kept
  // Background removal
  quality: 'fast' | 'accurate';
  threshold: number; // 0–100: how confident the model must be that a pixel is a person
  softness: number; // 0–100: edge feather
  shift: number; // -50–50: shrink (−) or grow (+) the cut-out
  smoothing: number; // 0–95: steadies the mask between frames (less flicker, slower to follow motion)
}

export const DEFAULT_KEY: KeySettings = {
  mode: 'none',
  color: '#00ff00',
  similarity: 40,
  smoothness: 8,
  spill: 10,
  quality: 'fast',
  threshold: 50,
  softness: 20,
  shift: 0,
  smoothing: 60,
};

export const keyOf = (item: SceneItem): KeySettings => ({ ...DEFAULT_KEY, ...item.key });

export interface Scene {
  id: string;
  name: string;
  items: SceneItem[]; // bottom -> top
}

export type TransitionType = 'cut' | 'fade' | 'slide' | 'dip';

interface Persisted {
  scenes: Scene[];
  programId: string;
  previewId: string;
  studioMode: boolean;
  transition: TransitionType;
  duration: number;
}

const STORAGE_KEY = 'wb.scenes';

export class SceneStore extends Emitter<{
  change: [];
  program: [string, string]; // from, to
  select: [];
}> {
  scenes: Scene[];
  programId: string;
  /** Scene shown in the editor (studio mode preview); same as program otherwise. */
  previewId: string;
  studioMode: boolean;
  transition: TransitionType;
  duration: number;
  selectedItemId: string | null = null;
  private saveTimer: number | undefined;

  // Undo/redo: snapshots of the scenes, taken after edits settle (a whole drag = one step).
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastSnap = '';
  private snapTimer: number | undefined;
  private restoring = false;
  /** Internal clipboard for Copy/Paste of scene items. */
  private clipboard: SceneItem | null = null;

  constructor() {
    super();
    const p = loadJSON<Partial<Persisted>>(STORAGE_KEY, {});
    this.scenes = p.scenes?.length ? p.scenes : [{ id: uid('s'), name: 'Scene 1', items: [] }];
    for (const s of this.scenes) s.items = s.items.map(normalizeItem);
    this.programId = this.find(p.programId)?.id ?? this.scenes[0].id;
    this.previewId = this.find(p.previewId)?.id ?? this.programId;
    this.studioMode = !!p.studioMode;
    this.transition = p.transition ?? 'fade';
    this.duration = p.duration ?? 500;
    this.lastSnap = JSON.stringify(this.scenes);
  }

  // ----- history -----
  get canUndo() {
    this.flushSnapshot();
    return this.undoStack.length > 0;
  }
  get canRedo() {
    this.flushSnapshot();
    return this.redoStack.length > 0;
  }

  private flushSnapshot() {
    if (this.snapTimer === undefined) return;
    clearTimeout(this.snapTimer);
    this.snapTimer = undefined;
    const snap = JSON.stringify(this.scenes);
    if (snap === this.lastSnap) return;
    this.undoStack.push(this.lastSnap);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastSnap = snap;
  }

  undo() {
    this.flushSnapshot();
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.lastSnap);
    this.restore(prev);
  }

  redo() {
    this.flushSnapshot();
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.lastSnap);
    this.restore(next);
  }

  private restore(snap: string) {
    this.lastSnap = snap;
    this.scenes = JSON.parse(snap);
    // Undo never switches what's live: keep program/preview if those scenes still exist.
    if (!this.find(this.programId)) this.programId = this.scenes[0].id;
    if (!this.find(this.previewId)) this.previewId = this.programId;
    if (this.selectedItemId && !this.selectedItem) this.selectedItemId = null;
    this.restoring = true;
    this.changed();
    this.restoring = false;
    this.emit('select');
  }

  // ----- clipboard -----
  get hasClipboard() {
    return !!this.clipboard;
  }

  copySelected() {
    const it = this.selectedItem;
    if (it) this.clipboard = structuredClone(it);
    return !!it;
  }

  cutSelected() {
    const it = this.selectedItem;
    if (!it || it.locked) return;
    this.copySelected();
    this.removeItem(it.id);
  }

  paste() {
    if (!this.clipboard) return;
    const { id: _id, ...rest } = structuredClone(this.clipboard);
    // Offset copies so they don't land exactly on top of the original.
    const taken = (x: number, y: number) => this.editing.items.some((i) => i.x === x && i.y === y);
    let { x, y } = rest;
    while (taken(x, y)) {
      x += 30;
      y += 30;
    }
    this.addItem({ ...rest, x, y, locked: false });
  }

  duplicateSelected() {
    if (this.copySelected()) this.paste();
  }

  find(id: string | undefined | null) {
    return this.scenes.find((s) => s.id === id);
  }

  get program() {
    return this.find(this.programId)!;
  }

  /** Scene being edited. */
  get editing() {
    return this.find(this.studioMode ? this.previewId : this.programId)!;
  }

  get selectedItem() {
    return this.editing.items.find((i) => i.id === this.selectedItemId) ?? null;
  }

  changed() {
    if (!this.restoring) {
      clearTimeout(this.snapTimer);
      this.snapTimer = window.setTimeout(() => this.flushSnapshot(), 400);
    }
    this.emit('change');
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      saveJSON(STORAGE_KEY, {
        scenes: this.scenes,
        programId: this.programId,
        previewId: this.previewId,
        studioMode: this.studioMode,
        transition: this.transition,
        duration: this.duration,
      } satisfies Persisted);
    }, 250);
  }

  // ----- scenes -----
  addScene(name?: string) {
    const s: Scene = { id: uid('s'), name: name ?? `Scene ${this.scenes.length + 1}`, items: [] };
    this.scenes.push(s);
    this.activate(s.id);
    return s;
  }

  duplicateScene(id: string) {
    const src = this.find(id);
    if (!src) return;
    const copy: Scene = structuredClone(src);
    copy.id = uid('s');
    copy.name = `${src.name} copy`;
    for (const it of copy.items) it.id = uid('i');
    this.scenes.splice(this.scenes.indexOf(src) + 1, 0, copy);
    this.changed();
  }

  removeScene(id: string) {
    if (this.scenes.length <= 1) return;
    const idx = this.scenes.findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.scenes.splice(idx, 1);
    const fallback = this.scenes[Math.max(0, idx - 1)].id;
    if (this.programId === id) this.setProgram(fallback);
    if (this.previewId === id) this.previewId = fallback;
    this.changed();
  }

  renameScene(id: string, name: string) {
    const s = this.find(id);
    if (s && name.trim()) {
      s.name = name.trim();
      this.changed();
    }
  }

  moveScene(id: string, delta: number) {
    const i = this.scenes.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.scenes.length) return;
    [this.scenes[i], this.scenes[j]] = [this.scenes[j], this.scenes[i]];
    this.changed();
  }

  /** Move a scene to a position in the list (drag to reorder). */
  moveSceneTo(id: string, index: number) {
    const i = this.scenes.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(this.scenes.length - 1, index));
    if (i === j) return;
    const [s] = this.scenes.splice(i, 1);
    this.scenes.splice(j, 0, s);
    this.changed();
  }

  /** Click on a scene: preview it in studio mode, take it live otherwise. */
  activate(id: string) {
    if (this.studioMode) {
      this.previewId = id;
      this.selectedItemId = null;
      this.changed();
    } else {
      this.setProgram(id);
    }
  }

  setProgram(id: string) {
    if (!this.find(id) || id === this.programId) return;
    const from = this.programId;
    this.programId = id;
    if (!this.studioMode) {
      this.previewId = id;
      this.selectedItemId = null;
    }
    this.emit('program', from, id);
    this.changed();
  }

  /** Studio mode: send preview to program (and swap, like OBS). */
  take() {
    if (!this.studioMode || this.previewId === this.programId) return;
    const prev = this.programId;
    this.setProgram(this.previewId);
    this.previewId = prev;
    this.changed();
  }

  setStudioMode(on: boolean) {
    this.studioMode = on;
    this.previewId = this.programId;
    this.changed();
  }

  // ----- items -----
  addItem(partial: Partial<SceneItem> & { source: ItemSource; name: string }, scene = this.editing) {
    const item = normalizeItem({ id: uid('i'), ...partial });
    scene.items.push(item);
    this.selectedItemId = item.id;
    this.changed();
    this.emit('select');
    return item;
  }

  updateItem(id: string, patch: Partial<SceneItem>, scene = this.editing) {
    const it = scene.items.find((i) => i.id === id);
    if (!it) return;
    Object.assign(it, patch);
    this.changed();
  }

  removeItem(id: string, scene = this.editing) {
    scene.items = scene.items.filter((i) => i.id !== id);
    if (this.selectedItemId === id) this.selectedItemId = null;
    this.changed();
    this.emit('select');
  }

  /** delta > 0 moves toward the top of the stack. */
  moveItem(id: string, delta: number, scene = this.editing) {
    const i = scene.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const j = Math.min(scene.items.length - 1, Math.max(0, i + delta));
    if (j === i) return;
    const [it] = scene.items.splice(i, 1);
    scene.items.splice(j, 0, it);
    this.changed();
  }

  /** Move an item to a stack position (0 = bottom/back). */
  moveItemTo(id: string, index: number, scene = this.editing) {
    const i = scene.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(scene.items.length - 1, index));
    if (i === j) return;
    const [it] = scene.items.splice(i, 1);
    scene.items.splice(j, 0, it);
    this.changed();
  }

  select(id: string | null) {
    if (this.selectedItemId === id) return;
    this.selectedItemId = id;
    this.emit('select');
    this.emit('change');
  }

  /**
   * A video source changed size. If it flipped orientation (e.g. a phone was
   * rotated), re-fit every auto-fit item showing it: full-screen items are
   * fitted to the screen again; smaller items (PiP) keep their center and
   * long edge but take the new aspect ratio.
   */
  refitInput(inputId: string, vw: number, vh: number) {
    const portrait = vh > vw;
    let changed = false;
    for (const scene of this.scenes) {
      for (const it of scene.items) {
        if (it.source.type !== 'input' || it.source.inputId !== inputId) continue;
        if (it.locked || it.fit === 'stretch') continue; // locked or stretched sources keep their box
        if (it.h > it.w === portrait) continue; // box already matches the orientation
        const fullScreen = it.w >= SCENE_W - 2 || it.h >= SCENE_H - 2;
        if (fullScreen) {
          Object.assign(it, fitBox(vw, vh));
        } else {
          const long = Math.max(it.w, it.h);
          let w = portrait ? (long * vw) / vh : long;
          let h = portrait ? long : (long * vh) / vw;
          const s = Math.min(1, SCENE_W / w, SCENE_H / h);
          w *= s;
          h *= s;
          const cx = it.x + it.w / 2;
          const cy = it.y + it.h / 2;
          it.w = Math.round(w);
          it.h = Math.round(h);
          it.x = Math.round(Math.min(SCENE_W - w, Math.max(0, cx - w / 2)));
          it.y = Math.round(Math.min(SCENE_H - h, Math.max(0, cy - h / 2)));
        }
        it.crop = { l: 0, t: 0, r: 0, b: 0 }; // crop of the old orientation no longer applies
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** Input ids visible in a scene (for tally). */
  inputsIn(scene: Scene | undefined) {
    const out = new Set<string>();
    for (const it of scene?.items ?? []) if (it.visible && it.source.type === 'input') out.add(it.source.inputId);
    return out;
  }
}

function normalizeItem(it: Partial<SceneItem> & { id: string }): SceneItem {
  return {
    name: 'Item',
    source: { type: 'color', color: '#000000' },
    x: 0,
    y: 0,
    w: SCENE_W,
    h: SCENE_H,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    fit: 'contain',
    flipH: false,
    opacity: 1,
    radius: 0,
    visible: true,
    locked: false,
    autoFit: true,
    ...it,
  } as SceneItem;
}

/** Box that fits a source of the given aspect inside the scene, centered. */
export function fitBox(srcW: number, srcH: number, maxW = SCENE_W, maxH = SCENE_H) {
  const s = Math.min(maxW / srcW, maxH / srcH);
  const w = Math.round(srcW * s);
  const h = Math.round(srcH * s);
  return { x: Math.round((SCENE_W - w) / 2), y: Math.round((SCENE_H - h) / 2), w, h };
}
