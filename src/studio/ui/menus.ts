// The studio's application menus (File / Edit / View / Scene / Sources / Help).

import { h } from '../../lib/util';
import type { Studio } from '../context';
import { PANELS, type DockingController, type PanelId } from '../docking';
import { SCENE_H, SCENE_W, fitBox, type TransitionType } from '../scenes';
import {
  canDeleteTarget,
  canMoveTarget,
  deleteScene,
  deleteTarget,
  duplicateTarget,
  focusTarget,
  moveTarget,
  newRoomCode,
  renameScene,
  renameTarget,
  type MoveDir,
  type Target,
} from './actions';
import { exportCollection, importCollection } from './collection';
import { openModal, type MenuEntry } from './common';
import { showConnect } from './devices-ui';
import { formatKeys, type Menu, type MenuItem } from './menubar';
import { addSourceMenu } from './scenes-dock';

/** Convert the older popup-menu entries (used by the + buttons) into menu items. */
export function fromEntries(entries: MenuEntry[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const e of entries) {
    if ('heading' in e) continue;
    if ('sep' in e) out.push({ sep: true });
    else out.push({ label: e.label + (e.sub ? `  (${e.sub})` : ''), disabled: e.disabled, onClick: e.onClick });
  }
  return out;
}

export function fullscreen(el: Element) {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen?.().catch(() => {});
}

/** View → Panels submenu (also used by right-click menus). */
export function panelsSubmenu(layout: DockingController): MenuItem[] {
  const panel = (id: PanelId): MenuItem => ({
    label: PANELS[id].title,
    checked: layout.isOpen(id),
    onClick: () => layout.toggle(id),
  });
  return [
    panel('program'),
    panel('properties'),
    { sep: true },
    panel('scenes'),
    panel('sources'),
    panel('mixer'),
    panel('devices'),
    panel('controls'),
  ];
}

/** Transition type picker (scene menus). */
export function transitionSubmenu(studio: Studio): MenuItem {
  const { store } = studio;
  return {
    label: 'Transition',
    submenu: () =>
      (
        [
          ['fade', 'Fade'],
          ['cut', 'Cut'],
          ['slide', 'Slide'],
          ['dip', 'Dip to Black'],
        ] as [TransitionType, string][]
      ).map(([type, label]) => ({
        label,
        radio: true,
        checked: store.transition === type,
        onClick: () => {
          store.transition = type;
          store.changed();
        },
      })),
  };
}

/**
 * The one menu layout for a scene or a source, used by both right-click menus
 * and the Edit menu so they're always organized the same way:
 *
 *   [main action]                  (scenes: switch / send to program)
 *   Rename · Duplicate · (sources: Cut · Copy · Paste)
 *   Move Up · Move Down · Move to Top · Move to Bottom
 *   (scenes: Transition ›)  (sources: Transform › · Lock · Hide)
 *   Delete
 *
 * `t` null = nothing to act on (items shown disabled, shortcuts still listed).
 */
export function itemMenu(studio: Studio, t: Target | null, primary: MenuItem[] = []): MenuItem[] {
  const { store, comp } = studio;
  const src = t?.kind === 'source' ? (store.editing.items.find((i) => i.id === t.id) ?? null) : null;
  const locked = !!src?.locked;
  const update = (patch: Parameters<typeof store.updateItem>[1]) => {
    if (src) store.updateItem(src.id, patch);
  };
  const sourceSize = () => {
    const n = src && comp.naturalSize(src);
    if (!src || !n) return null;
    const c = src.crop;
    return { w: n.w * (1 - c.l - c.r), h: n.h * (1 - c.t - c.b) };
  };
  const can = (dir: MoveDir) => !!t && canMoveTarget(studio, t, dir);
  const move = (dir: MoveDir) => () => t && moveTarget(studio, t, dir);
  const withSource = (fn: () => void) => () => {
    if (!src) return;
    store.select(src.id);
    fn();
  };

  const items: MenuItem[] = [];
  if (primary.length) items.push(...primary, { sep: true });

  // Edit
  items.push(
    { label: 'Rename', keys: 'F2', disabled: !t, onClick: () => t && renameTarget(studio, t) },
    { label: 'Duplicate', keys: 'Ctrl+D', disabled: !t, onClick: () => t && duplicateTarget(studio, t) },
  );
  if (t?.kind !== 'scene') {
    items.push(
      { label: 'Cut', keys: 'Ctrl+X', disabled: !src || locked, onClick: withSource(() => store.cutSelected()) },
      { label: 'Copy', keys: 'Ctrl+C', disabled: !src, onClick: withSource(() => store.copySelected()) },
      { label: 'Paste', keys: 'Ctrl+V', disabled: !store.hasClipboard, onClick: () => store.paste() },
    );
  }

  // Order
  items.push(
    { sep: true },
    { label: 'Move Up', keys: 'Ctrl+ArrowUp', disabled: !can('up'), onClick: move('up') },
    { label: 'Move Down', keys: 'Ctrl+ArrowDown', disabled: !can('down'), onClick: move('down') },
    { label: 'Move to Top', keys: 'Ctrl+Shift+ArrowUp', disabled: !can('top'), onClick: move('top') },
    { label: 'Move to Bottom', keys: 'Ctrl+Shift+ArrowDown', disabled: !can('bottom'), onClick: move('bottom') },
    { sep: true },
  );

  // Type-specific
  if (t?.kind === 'scene') {
    items.push(transitionSubmenu(studio));
  } else {
    items.push(
      {
        label: 'Transform',
        disabled: !src || locked,
        submenu: () => [
          {
            label: 'Fit to Screen',
            onClick: () => {
              const s = sourceSize();
              update(s ? { ...fitBox(s.w, s.h), fit: 'contain' } : { x: 0, y: 0, w: SCENE_W, h: SCENE_H });
            },
          },
          { label: 'Stretch to Screen', onClick: () => update({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fit: 'stretch' }) },
          {
            label: 'Center',
            onClick: () => src && update({ x: Math.round((SCENE_W - src.w) / 2), y: Math.round((SCENE_H - src.h) / 2) }),
          },
          { sep: true },
          { label: 'Mirror Horizontally', checked: !!src?.flipH, onClick: () => update({ flipH: !src?.flipH }) },
          { label: 'Reset Crop', onClick: () => update({ crop: { l: 0, t: 0, r: 0, b: 0 } }) },
        ],
      },
      { label: 'Lock', checked: locked, disabled: !src, keys: 'Ctrl+L', onClick: () => update({ locked: !src?.locked }) },
      { label: 'Hide', checked: src?.visible === false, disabled: !src, keys: 'Ctrl+H', onClick: () => update({ visible: !src?.visible }) },
    );
  }

  // Delete (always last, red)
  items.push(
    { sep: true },
    {
      label: 'Delete',
      keys: 'Delete|Backspace',
      danger: true,
      disabled: !t || !canDeleteTarget(studio, t),
      onClick: () => t && deleteTarget(studio, t),
    },
  );
  return items;
}

export function buildMenus(studio: Studio, layout: DockingController, controls: { toggleRecording: () => void }): Menu[] {
  const { store, recorder } = studio;
  const noSel = () => !store.selectedItem;

  const menus: Menu[] = [
    {
      label: 'File',
      key: 'F',
      items: () => [
        {
          label: recorder.state === 'inactive' ? 'Start Recording' : 'Stop Recording',
          keys: 'F9',
          onClick: controls.toggleRecording,
        },
        {
          label: recorder.state === 'paused' ? 'Resume Recording' : 'Pause Recording',
          keys: 'Shift+F9',
          disabled: recorder.state === 'inactive',
          onClick: () => recorder.togglePause(),
        },
        { sep: true },
        { label: 'Export Scene Collection…', keys: 'Ctrl+E', onClick: () => void exportCollection(studio) },
        { label: 'Import Scene Collection…', onClick: () => importCollection(studio) },
        { sep: true },
        {
          label: 'Output Settings…',
          onClick: () => {
            layout.show('controls');
            document.querySelector<HTMLElement>('#dock-controls select')?.focus();
          },
        },
        ...(studio.room
          ? [
              { sep: true } as const,
              {
                label: 'New Room Code…',
                onClick: () => void newRoomCode(),
              },
            ]
          : []),
      ],
    },
    {
      label: 'Edit',
      key: 'E',
      items: () => [
        { label: 'Undo', keys: 'Ctrl+Z', disabled: !store.canUndo, onClick: () => store.undo() },
        { label: 'Redo', keys: 'Ctrl+Y|Ctrl+Shift+Z', disabled: !store.canRedo, onClick: () => store.redo() },
        { sep: true },
        // Acts on the scene or source you last worked with (see actions.ts focusTarget)
        ...itemMenu(studio, focusTarget(studio)),
        { sep: true },
        { label: 'Select None', hint: 'Esc', disabled: noSel(), onClick: () => store.select(null) },
      ],
    },
    {
      label: 'View',
      key: 'V',
      items: () => [
        { label: 'Studio Mode', checked: store.studioMode, keys: 'Ctrl+M', onClick: () => store.setStudioMode(!store.studioMode) },
        { sep: true },
        {
          label: 'Panels',
          submenu: () => panelsSubmenu(layout),
        },
        { label: 'Reset Layout', onClick: () => layout.reset() },
        { sep: true },
        {
          label: 'Program Output Full Screen',
          keys: 'Ctrl+Shift+P',
          onClick: () => fullscreen(document.getElementById('wrap-program')!),
        },
        {
          label: 'Full Screen',
          checked: !!document.fullscreenElement,
          keys: 'Ctrl+Shift+F',
          onClick: () => fullscreen(document.documentElement),
        },
      ],
    },
    {
      label: 'Scene',
      key: 'S',
      items: () => {
        const editing = store.editing;
        return [
          { label: 'New Scene', onClick: () => store.addScene() },
          { label: 'Duplicate Scene', onClick: () => store.duplicateScene(editing.id) },
          {
            label: 'Rename Scene',
            hint: 'F2',
            onClick: () => void renameScene(studio, editing.id),
          },
          {
            label: 'Delete Scene',
            danger: true,
            disabled: store.scenes.length <= 1,
            onClick: () => void deleteScene(studio, editing.id),
          },
          { label: 'Move Up', onClick: () => store.moveScene(editing.id, -1) },
          { label: 'Move Down', onClick: () => store.moveScene(editing.id, 1) },
          { sep: true },
          {
            label: 'Transition',
            submenu: () =>
              (
                [
                  ['fade', 'Fade'],
                  ['cut', 'Cut'],
                  ['slide', 'Slide'],
                  ['dip', 'Dip to Black'],
                ] as [TransitionType, string][]
              ).map(([t, label]) => ({
                label,
                radio: true,
                checked: store.transition === t,
                onClick: () => {
                  store.transition = t;
                  store.changed();
                },
              })),
          },
          {
            label: 'Transition to Program',
            hint: 'Enter',
            disabled: !store.studioMode || store.previewId === store.programId,
            onClick: () => store.take(),
          },
          { sep: true },
          ...store.scenes.slice(0, 20).map(
            (s, i): MenuItem => ({
              label: s.name,
              radio: true,
              checked: s.id === store.programId,
              hint: i < 9 ? String(i + 1) : undefined,
              onClick: () => store.activate(s.id),
            }),
          ),
        ];
      },
    },
    {
      label: 'Sources',
      key: 'o',
      items: () => [
        { label: 'Connect a Phone or Device…', onClick: () => void showConnect(studio) },
        { sep: true },
        ...fromEntries(addSourceMenu(studio)),
      ],
    },
    {
      label: 'Help',
      key: 'H',
      items: () => [
        { label: 'Keyboard Shortcuts', keys: 'Ctrl+/', onClick: () => showShortcuts(studio, menus) },
        { label: 'Connecting Devices', onClick: () => void showConnect(studio) },
        { sep: true },
        { label: 'About WebBroadcaster', onClick: () => showAbout(studio) },
      ],
    },
  ];
  return menus;
}

/** Shortcuts that don't belong to a menu item, listed after the menu ones. */
const OTHER_SHORTCUTS: [group: string, keys: string, what: string][] = [
  ['Scenes', '1 – 9', 'Switch to scene 1–9 (in Studio Mode: show it in Preview)'],
  ['Scenes', 'Enter', 'Transition Preview to Program (Studio Mode)'],
  ['Scenes', 'Double-click name', 'Rename scene'],
  ['Scenes', 'Drag', 'Reorder scenes (Esc cancels)'],
  ['Sources', 'Arrow keys', 'Nudge selected source 1 px'],
  ['Sources', 'Shift + Arrow keys', 'Nudge selected source 10 px'],
  ['Sources', 'Esc', 'Deselect source'],
  ['Sources', 'Double-click name', 'Rename source'],
  ['Sources', 'Drag', 'Reorder sources (Esc cancels)'],
  ['Canvas', 'Drag', 'Move source (snaps to edges and center)'],
  ['Canvas', 'Drag a handle', 'Resize (corners keep the aspect ratio)'],
  ['Canvas', 'Shift + drag a handle', 'Resize freely'],
  ['Canvas', 'Alt + drag a handle', 'Crop'],
  ['Canvas', 'Ctrl + drag', 'Move or resize without snapping'],
  ['Canvas', 'Double-click text', 'Edit text in place'],
  ['Canvas', 'Ctrl+Enter or click outside', 'Finish editing text'],
  ['Canvas', 'Esc (while editing text)', 'Cancel text edit'],
  ['Everywhere', 'Right-click', 'Menu for whatever is under the pointer'],
  ['Everywhere', 'Alt', 'Open the menu bar (then arrow keys, Enter, Esc)'],
  ['Everywhere', 'Alt + underlined letter', 'Open that menu (e.g. Alt+F for File)'],
  ['Everywhere', 'Esc', 'Close menus and dialogs'],
];

/**
 * Help → Keyboard Shortcuts. Built from the live menus (every item with a
 * shortcut, including submenus), so new shortcuts show up automatically,
 * followed by the ones that aren't on a menu.
 */
function showShortcuts(studio: Studio, menus: Menu[]) {
  const groups = new Map<string, [string, string][]>();
  const add = (group: string, keys: string, what: string) => {
    const rows = groups.get(group) ?? [];
    if (!rows.some(([k, w]) => k === keys && w === what)) rows.push([keys, what]);
    groups.set(group, rows);
  };
  const walk = (group: string, items: MenuItem[], path: string) => {
    for (const it of items) {
      if ('sep' in it) continue;
      const label = path ? `${path} › ${it.label}` : it.label;
      if (it.submenu) walk(group, it.submenu(), label);
      // Per-scene "1–9" hints are listed once under Scenes instead.
      else if (it.keys) add(group, formatKeys(it.keys), label);
      else if (it.hint && !/^[1-9]$/.test(it.hint) && it.hint !== 'Enter') add(group, it.hint, label);
    }
  };
  for (const m of menus) walk(m.label, m.items(), '');
  // Source shortcuts appear in Edit only while a source is focused; always list them.
  walk('Edit', itemMenu(studio, null), '');
  for (const [group, keys, what] of OTHER_SHORTCUTS) add(group, keys, what);

  const table = h('table.shortcut-table');
  for (const [group, rows] of groups) {
    if (!rows.length) continue;
    table.append(h('tr.shortcut-group', null, h('th', { colspan: '2' }, group)));
    for (const [k, what] of rows) table.append(h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, what)));
  }
  openModal('Keyboard Shortcuts', table);
}

function showAbout(studio: Studio) {
  openModal(
    'About WebBroadcaster',
    h('p', null, 'A browser-based live production studio. Phones, tablets and computers on your network become cameras and microphones.'),
    h(
      'p',
      null,
      studio.sig.mode === 'relay'
        ? 'Connection mode: hosted. Devices find each other through encrypted public relays; video and audio stay on your local network.'
        : 'Connection mode: local server. Devices connect through the WebBroadcaster server on this network.',
    ),
  );
}
