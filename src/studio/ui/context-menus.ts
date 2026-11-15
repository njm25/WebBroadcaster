// Right-click menus for the whole studio. The browser's own menu is replaced
// everywhere except text fields (so copy/paste in an input still works) and
// panel tabs (which keep dockview's float / pop out / maximize menu).

import type { Studio } from '../context';
import type { DockingController } from '../docking';
import { MASTER, MIN_DB } from '../mixer';
import { remoteInputId } from '../remote';
import { addDeviceMenu, removeDeviceEntry, removeLabel, showConnect } from './devices-ui';
import { contextMenu, type MenuItem } from './menubar';
import { fromEntries, fullscreen, itemMenu, panelsSubmenu, transitionSubmenu } from './menus';
import { addSourceMenu, pickDevice } from './scenes-dock';
import { setSyncOffset } from './actions';
import { errMsg, toast } from './common';

type Controls = { toggleRecording: () => void };

export function mountContextMenus(studio: Studio, dock: DockingController, controls: Controls) {
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('input:not([type=checkbox]):not([type=range]):not([type=color]), textarea, [contenteditable]')) return;
    if (t.closest('.dv-tab')) return; // dockview's own tab menu
    e.preventDefault();
    contextMenu.open(e.clientX, e.clientY, itemsFor(studio, dock, controls, t, e));
  });
}

function itemsFor(studio: Studio, dock: DockingController, controls: Controls, t: Element, e: MouseEvent): MenuItem[] {
  const { store } = studio;
  const inPanel = (id: string) => !!t.closest(`#${id}`);

  // ---- Scenes ----
  const sceneEl = t.closest<HTMLElement>('[data-scene-id]');
  if (sceneEl) return sceneMenu(studio, sceneEl.dataset.sceneId!);
  if (inPanel('dock-scenes')) return [{ label: 'New Scene', onClick: () => store.addScene() }, { sep: true }, transitionSubmenu(studio)];

  // ---- Sources list ----
  const itemEl = t.closest<HTMLElement>('[data-item-id]');
  if (itemEl) {
    store.select(itemEl.dataset.itemId!);
    return sourceMenu(studio);
  }
  if (inPanel('dock-sources')) return emptySourcesMenu(studio);

  // ---- Canvas (scene editor) ----
  if (t.closest('.editor-overlay')) {
    const hit = studio.editor.itemAt(e.clientX, e.clientY);
    if (hit) {
      store.select(hit.id);
      return sourceMenu(studio);
    }
    store.select(null);
    return [...emptySourcesMenu(studio), { sep: true }, ...viewItems(studio, dock)];
  }
  if (inPanel('panel-program')) return [...viewItems(studio, dock), { sep: true }, ...recordingItems(studio, controls)];

  // ---- Audio mixer ----
  const strip = t.closest<HTMLElement>('#dock-mixer [data-input-id]');
  if (strip) return mixerMenu(studio, strip.dataset.inputId!);
  if (inPanel('dock-mixer')) return mixerPanelMenu(studio);

  // ---- Devices ----
  const peerEl = t.closest<HTMLElement>('[data-peer-id]');
  if (peerEl) return remoteDeviceMenu(studio, peerEl.dataset.peerId!);
  const localEl = t.closest<HTMLElement>('#dock-devices [data-input-id]');
  if (localEl) return localInputMenu(studio, localEl.dataset.inputId!);
  const offlineEl = t.closest<HTMLElement>('[data-device-id]');
  if (offlineEl) {
    const key = `offline:${offlineEl.dataset.deviceId!}`;
    return [
      { label: removeLabel(studio, key), onClick: () => removeDeviceEntry(studio, key) },
      { sep: true },
      { label: 'Connect a Phone or Device…', onClick: () => void showConnect(studio) },
    ];
  }
  if (inPanel('dock-devices')) return fromEntries(addDeviceMenu(studio));

  // ---- Controls / Properties ----
  if (inPanel('dock-controls')) return recordingItems(studio, controls);
  if (inPanel('props') && store.selectedItem) return sourceMenu(studio);

  // ---- Anywhere else ----
  return generalMenu(studio, dock);
}

// ------------------------------------------------------------------ builders

function sceneMenu(studio: Studio, id: string): MenuItem[] {
  const { store } = studio;
  if (!store.find(id)) return [];
  const isLive = id === store.programId;
  const index = store.scenes.findIndex((s) => s.id === id);
  // Main action(s) first, then the shared scene/source layout (menus.ts itemMenu).
  const primary: MenuItem[] = [
    {
      label: store.studioMode ? 'Show in Preview' : 'Switch to Scene',
      hint: index >= 0 && index < 9 ? String(index + 1) : undefined,
      disabled: store.studioMode ? id === store.previewId : isLive,
      onClick: () => store.activate(id),
    },
  ];
  if (store.studioMode) {
    primary.push({
      label: 'Send to Program',
      // Enter transitions the preview scene, so it's this scene's shortcut only when previewed.
      hint: id === store.previewId ? 'Enter' : undefined,
      disabled: isLive,
      onClick: () => store.setProgram(id),
    });
  }
  return itemMenu(studio, { kind: 'scene', id }, primary);
}

function sourceMenu(studio: Studio): MenuItem[] {
  const it = studio.store.selectedItem;
  if (!it) return emptySourcesMenu(studio);
  const offline = it.source.type === 'input' && !studio.registry.get(it.source.inputId)?.online;
  return [
    ...(offline ? [{ label: 'Source is offline', disabled: true } as MenuItem, { sep: true } as MenuItem] : []),
    ...itemMenu(studio, { kind: 'source', id: it.id }),
  ];
}

function emptySourcesMenu(studio: Studio): MenuItem[] {
  const { store } = studio;
  return [
    { label: 'Add Source', submenu: () => fromEntries(addSourceMenu(studio)) },
    { label: 'Paste', keys: 'Ctrl+V', disabled: !store.hasClipboard, onClick: () => store.paste() },
  ];
}

function mixerMenu(studio: Studio, id: string): MenuItem[] {
  const { mixer, registry } = studio;
  const s = mixer.get(id);
  const input = id === MASTER ? null : registry.get(id);
  const items: MenuItem[] = [
    { label: s.muted ? 'Unmute' : 'Mute', onClick: () => mixer.set(id, { muted: !s.muted }) },
    { label: 'Monitor (hear on this computer)', checked: s.monitor, onClick: () => mixer.set(id, { monitor: !s.monitor }) },
    { sep: true },
    {
      label: 'Volume',
      submenu: () =>
        [6, 0, -6, -12, -20].map((db) => ({
          label: `${db > 0 ? '+' : ''}${db} dB`,
          radio: true,
          checked: Math.abs(s.volumeDb - db) < 0.25,
          onClick: () => mixer.set(id, { volumeDb: db }),
        })),
    },
    { label: 'Reset Volume (0 dB)', disabled: s.volumeDb === 0, onClick: () => mixer.set(id, { volumeDb: 0 }) },
    { label: 'Silence (−∞)', disabled: s.volumeDb <= MIN_DB, onClick: () => mixer.set(id, { volumeDb: MIN_DB }) },
  ];
  if (id !== MASTER) {
    items.push(
      { sep: true },
      {
        label: 'Sync Offset…',
        hint: s.delayMs ? `${s.delayMs} ms` : '',
        onClick: () => void setSyncOffset(studio, id),
      },
    );
    // A phone's mic can also be muted at the source.
    if (input?.origin === 'remote') {
      const dev = [...studio.remote.devices.values()].find((d) => d.peer.deviceId === input.deviceId);
      if (dev) {
        const enabled = dev.peer.state.sources?.find((x) => x.key === 'mic')?.enabled;
        items.push({
          label: enabled ? 'Turn Off Mic on Device' : 'Turn On Mic on Device',
          onClick: () => studio.remote.control(dev.peer.id, { action: 'setMic', value: !enabled }),
        });
      }
    }
  }
  return items;
}

function mixerPanelMenu(studio: Studio): MenuItem[] {
  const { mixer } = studio;
  const ids = mixer.strips().map((s) => s.id);
  return [
    { label: 'Add Microphone…', onClick: () => void pickDevice(studio, 'audioinput') },
    { sep: true },
    { label: 'Mute All', disabled: !ids.length, onClick: () => ids.forEach((id) => mixer.set(id, { muted: true })) },
    { label: 'Unmute All', disabled: !ids.length, onClick: () => ids.forEach((id) => mixer.set(id, { muted: false })) },
    { label: 'Stop All Monitoring', onClick: () => [MASTER, ...ids].forEach((id) => mixer.set(id, { monitor: false })) },
  ];
}

function remoteDeviceMenu(studio: Studio, peerId: string): MenuItem[] {
  const dev = studio.remote.devices.get(peerId);
  if (!dev) return [];
  const { peer } = dev;
  const ctl = (action: Parameters<typeof studio.remote.control>[1]) => studio.remote.control(peerId, action);
  const cam = peer.state.sources?.find((s) => s.key === 'camera');
  const mic = peer.state.sources?.find((s) => s.key === 'mic');
  const camInput = remoteInputId(peer.deviceId, 'camera');
  const key = `peer:${peerId}`;
  return [
    {
      label: 'Add Camera to Scene',
      disabled: !studio.registry.get(camInput),
      onClick: () => studio.addInputItem(camInput),
    },
    { sep: true },
    { label: cam?.enabled ? 'Turn Camera Off' : 'Turn Camera On', onClick: () => ctl({ action: 'setCamera', value: !cam?.enabled }) },
    { label: 'Flip Camera', disabled: !cam?.enabled, onClick: () => ctl({ action: 'flipCamera' }) },
    { label: mic?.enabled ? 'Mute Microphone' : 'Unmute Microphone', onClick: () => ctl({ action: 'setMic', value: !mic?.enabled }) },
    {
      label: 'Camera Quality',
      submenu: () =>
        (['720p', '1080p', '4k'] as const).map((q) => ({
          label: q === '4k' ? '4K' : q,
          onClick: () => ctl({ action: 'setQuality', value: q }),
        })),
    },
    { sep: true },
    { label: removeLabel(studio, key), onClick: () => removeDeviceEntry(studio, key) },
  ];
}

function localInputMenu(studio: Studio, id: string): MenuItem[] {
  const input = studio.registry.get(id);
  if (!input) return [];
  const key = `input:${id}`;
  return [
    ...(input.kind === 'video' ? [{ label: 'Add to Scene', onClick: () => studio.addInputItem(id) } as MenuItem] : []),
    {
      label: 'Reconnect',
      disabled: input.online,
      onClick: () => studio.local.reconnect(id).catch((err) => toast(`Reconnect failed: ${errMsg(err)}`)),
    },
    { sep: true },
    { label: removeLabel(studio, key), onClick: () => removeDeviceEntry(studio, key) },
  ];
}

function recordingItems(studio: Studio, controls: Controls): MenuItem[] {
  const { recorder } = studio;
  return [
    { label: recorder.state === 'inactive' ? 'Start Recording' : 'Stop Recording', keys: 'F9', onClick: controls.toggleRecording },
    {
      label: recorder.state === 'paused' ? 'Resume Recording' : 'Pause Recording',
      keys: 'Shift+F9',
      disabled: recorder.state === 'inactive',
      onClick: () => recorder.togglePause(),
    },
  ];
}

function viewItems(studio: Studio, dock: DockingController): MenuItem[] {
  const { store } = studio;
  return [
    { label: 'Studio Mode', checked: store.studioMode, keys: 'Ctrl+M', onClick: () => store.setStudioMode(!store.studioMode) },
    { label: 'Program Output Full Screen', keys: 'Ctrl+Shift+P', onClick: () => fullscreen(document.getElementById('wrap-program')!) },
    { label: 'Panels', submenu: () => panelsSubmenu(dock) },
  ];
}

function generalMenu(studio: Studio, dock: DockingController): MenuItem[] {
  const { store } = studio;
  return [
    { label: 'Undo', keys: 'Ctrl+Z', disabled: !store.canUndo, onClick: () => store.undo() },
    { label: 'Redo', keys: 'Ctrl+Y', disabled: !store.canRedo, onClick: () => store.redo() },
    { label: 'Paste', keys: 'Ctrl+V', disabled: !store.hasClipboard, onClick: () => store.paste() },
    { sep: true },
    ...viewItems(studio, dock),
    { label: 'Reset Layout', onClick: () => dock.reset() },
  ];
}
