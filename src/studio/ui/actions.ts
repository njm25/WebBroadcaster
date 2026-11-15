// Studio actions that need a confirmation or a typed value, shared by the
// menu bar, toolbars and right-click menus so each one asks the same way.

import { confirmDialog, promptDialog } from '../../lib/dialog';
import { resetStudioRoom } from '../../lib/room';
import type { Studio } from '../context';
import { inlineRename } from './common';

export async function deleteScene(studio: Studio, id: string) {
  const { store } = studio;
  const scene = store.find(id);
  if (!scene || store.scenes.length <= 1) return;
  const n = scene.items.length;
  const ok = await confirmDialog(
    n ? `"${scene.name}" and its ${n} source${n === 1 ? '' : 's'} will be removed.` : `"${scene.name}" will be removed.`,
    { title: 'Delete scene?', okLabel: 'Delete', danger: true },
  );
  if (ok) store.removeScene(id);
}

/** The row's name element if that list row is currently on screen. */
function visibleNameEl(selector: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(selector);
  return el && el.isConnected && el.offsetParent !== null ? el : null;
}

/** Rename a scene: inline in the Scenes list (like double-click), or a dialog if the list is hidden. */
export async function renameScene(studio: Studio, id: string) {
  const scene = studio.store.find(id);
  if (!scene) return;
  const nameEl = visibleNameEl(`#dock-scenes [data-scene-id="${CSS.escape(id)}"] .name`);
  if (nameEl) {
    inlineRename(nameEl, scene.name, (v) => studio.store.renameScene(id, v));
    return;
  }
  const name = await promptDialog('Rename scene', { value: scene.name, okLabel: 'Rename' });
  if (name) studio.store.renameScene(id, name);
}

/** Rename a source: inline in the Sources list, or a dialog if the list is hidden. */
export async function renameSource(studio: Studio, itemId: string) {
  const it = studio.store.editing.items.find((i) => i.id === itemId);
  if (!it) return;
  const nameEl = visibleNameEl(`#dock-sources [data-item-id="${CSS.escape(itemId)}"] .name`);
  if (nameEl) {
    inlineRename(nameEl, it.name, (v) => studio.store.updateItem(itemId, { name: v }));
    return;
  }
  const name = await promptDialog('Rename source', { value: it.name, okLabel: 'Rename' });
  if (name) studio.store.updateItem(itemId, { name });
}

// F2 renames whatever list you last worked in: Scenes, or Sources/canvas.
let lastList: 'scenes' | 'sources' = 'sources';
document.addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target as Element | null;
    if (!t?.closest) return;
    if (t.closest('#dock-scenes')) lastList = 'scenes';
    else if (t.closest('#dock-sources, .editor-overlay, #props')) lastList = 'sources';
  },
  true,
);

export function renameFocused(studio: Studio) {
  const t = focusTarget(studio);
  if (t) renameTarget(studio, t);
}

// ------------------------------------------------------------------ targets
// A "target" is the scene or source an action applies to. Keyboard shortcuts
// act on the focused one (the list you last clicked in); right-click menus
// act on the row you right-clicked. Both use the same functions below.

export type Target = { kind: 'scene'; id: string } | { kind: 'source'; id: string };
export type MoveDir = 'up' | 'down' | 'top' | 'bottom';

/** The scene (if you last worked in Scenes) or the selected source. */
export function focusTarget(studio: Studio): Target | null {
  if (lastList === 'scenes') return { kind: 'scene', id: studio.store.editing.id };
  const it = studio.store.selectedItem;
  return it ? { kind: 'source', id: it.id } : null;
}

const sourceItem = (studio: Studio, id: string) => studio.store.editing.items.find((i) => i.id === id);

export function renameTarget(studio: Studio, t: Target) {
  if (t.kind === 'scene') void renameScene(studio, t.id);
  else void renameSource(studio, t.id);
}

export function duplicateTarget(studio: Studio, t: Target) {
  if (t.kind === 'scene') studio.store.duplicateScene(t.id);
  else {
    studio.store.select(t.id);
    studio.store.duplicateSelected();
  }
}

export function canDeleteTarget(studio: Studio, t: Target) {
  return t.kind === 'scene' ? studio.store.scenes.length > 1 : !!sourceItem(studio, t.id) && !sourceItem(studio, t.id)!.locked;
}

export function deleteTarget(studio: Studio, t: Target) {
  if (!canDeleteTarget(studio, t)) return;
  if (t.kind === 'scene') void deleteScene(studio, t.id);
  else studio.store.removeItem(t.id);
}

/**
 * Up/top = toward the top of the list. For sources the list shows the
 * front-most source first, so "up" brings a source forward.
 */
export function canMoveTarget(studio: Studio, t: Target, dir: MoveDir) {
  const { store } = studio;
  if (t.kind === 'scene') {
    const i = store.scenes.findIndex((s) => s.id === t.id);
    return dir === 'up' || dir === 'top' ? i > 0 : i >= 0 && i < store.scenes.length - 1;
  }
  const items = store.editing.items;
  const i = items.findIndex((x) => x.id === t.id);
  if (i < 0) return false;
  return dir === 'up' || dir === 'top' ? i < items.length - 1 : i > 0;
}

export function moveTarget(studio: Studio, t: Target, dir: MoveDir) {
  const { store } = studio;
  if (t.kind === 'scene') {
    if (dir === 'up') store.moveScene(t.id, -1);
    else if (dir === 'down') store.moveScene(t.id, 1);
    else store.moveSceneTo(t.id, dir === 'top' ? 0 : store.scenes.length - 1);
  } else {
    if (dir === 'up') store.moveItem(t.id, 1);
    else if (dir === 'down') store.moveItem(t.id, -1);
    else store.moveItemTo(t.id, dir === 'top' ? store.editing.items.length - 1 : 0);
  }
}

export async function setSyncOffset(studio: Studio, inputId: string) {
  const current = studio.mixer.get(inputId).delayMs;
  const v = await promptDialog('Audio sync offset', {
    message: 'Delay this audio (in milliseconds) to line it up with its video. 0–2000 ms.',
    value: String(current),
    type: 'number',
    min: 0,
    max: 2000,
    okLabel: 'Set',
    validate: (s) => {
      const n = Number(s);
      return s.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 2000 ? null : 'Enter a number from 0 to 2000.';
    },
  });
  if (v !== null) studio.mixer.set(inputId, { delayMs: Math.round(Number(v)) });
}

export async function disconnectDevice(studio: Studio, peerId: string) {
  const name = studio.remote.devices.get(peerId)?.peer.name ?? 'this device';
  const ok = await confirmDialog(`"${name}" returns to its join screen. It can reconnect later.`, {
    title: 'Disconnect device?',
    okLabel: 'Disconnect',
    danger: true,
  });
  if (ok) studio.remote.control(peerId, { action: 'disconnect' });
}

export async function newRoomCode(): Promise<boolean> {
  const ok = await confirmDialog(
    'The current join link and QR code stop working. Connected devices will need to scan the new code.',
    { title: 'Create a new room code?', okLabel: 'New code', danger: true },
  );
  if (ok) {
    resetStudioRoom();
    location.reload();
  }
  return ok;
}
