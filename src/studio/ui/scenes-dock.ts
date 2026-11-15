import { icon } from '../../lib/icons';
import { assets, h, uid } from '../../lib/util';
import type { Studio } from '../context';
import type { Surface } from '../local';
import { SCENE_H, SCENE_W, fitBox, type SceneItem } from '../scenes';
import { errMsg, iconBtn, inlineRename, openMenu, openModal, toast, toolBtn, type MenuEntry } from './common';

export function itemIcon(studio: Studio, it: SceneItem) {
  const s = it.source;
  if (s.type === 'text') return 'text';
  if (s.type === 'image') return 'image';
  if (s.type === 'color') return 'square';
  const input = studio.registry.get(s.inputId);
  if (!input) return 'camera';
  if (input.type === 'screen') return 'screen';
  return input.origin === 'remote' ? 'phone' : 'camera';
}

// ---------------------------------------------------------------- Scenes
export function mountScenesDock(studio: Studio, root: HTMLElement) {
  const { store } = studio;
  const list = h('div.list');
  const toolbar = h('div.toolbar');
  root.append(list, toolbar);

  const render = () => {
    list.replaceChildren(
      ...store.scenes.map((s, i) => {
        const isProgram = s.id === store.programId;
        const isPreview = store.studioMode && s.id === store.previewId;
        const name = h('span.name', null, s.name);
        const el = h(
          'div.list-item',
          {
            class: `list-item${s.id === store.editing.id ? ' selected' : ''}${isProgram ? ' program' : ''}${isPreview && !isProgram ? ' preview' : ''}`,
            onclick: () => store.activate(s.id),
            ondblclick: () => inlineRename(name, s.name, (v) => store.renameScene(s.id, v)),
            title: 'Click to switch · double-click to rename',
          },
          name,
          isProgram ? h('span.tag.live', null, 'LIVE') : null,
          isPreview && !isProgram ? h('span.tag.pvw', null, 'PVW') : null,
          i < 9 ? h('span.hk', null, String(i + 1)) : null,
        );
        return el;
      }),
    );
    const cur = store.editing.id;
    toolbar.replaceChildren(
      toolBtn('plus', 'Add scene', () => store.addScene()),
      toolBtn('trash', 'Delete scene', () => {
        if (confirm(`Delete scene "${store.editing.name}"?`)) store.removeScene(cur);
      }, store.scenes.length <= 1),
      toolBtn('up', 'Move up', () => store.moveScene(cur, -1)),
      toolBtn('down', 'Move down', () => store.moveScene(cur, 1)),
      h(
        'button.btn.ghost',
        { title: 'Duplicate scene', onclick: () => store.duplicateScene(cur), style: { fontSize: '12px' } },
        'Dup',
      ),
    );
  };
  store.on('change', render);
  render();
}

// ---------------------------------------------------------------- Sources
export function mountSourcesDock(studio: Studio, root: HTMLElement) {
  const { store, registry } = studio;
  const list = h('div.list');
  const toolbar = h('div.toolbar');
  root.append(list, toolbar);

  const addBtn = h('button.btn.ghost', { title: 'Add source', 'aria-label': 'Add source' }, icon('plus'));
  addBtn.addEventListener('click', () => openMenu(addBtn, addSourceMenu(studio)));

  const render = () => {
    const scene = store.editing;
    const items = [...scene.items].reverse();
    if (!items.length) {
      list.replaceChildren(
        h(
          'div.list-empty',
          null,
          'No sources in this scene. Press + to add a phone camera, webcam, screen capture, image or text.',
        ),
      );
    } else {
      list.replaceChildren(
        ...items.map((it) => {
          const name = h('span.name', null, it.name);
          const offline =
            it.source.type === 'input' && !registry.get(it.source.inputId)?.online;
          return h(
            'div.list-item',
            {
              class: `list-item${it.id === store.selectedItemId ? ' selected' : ''}${it.visible ? '' : ' hidden-item'}${offline ? ' offline' : ''}`,
              onclick: () => store.select(it.id),
              ondblclick: () => inlineRename(name, it.name, (v) => store.updateItem(it.id, { name: v })),
              title: offline ? 'Source offline' : it.name,
            },
            icon(itemIcon(studio, it)),
            name,
            iconBtn(it.visible ? 'eye' : 'eyeOff', it.visible ? 'Hide' : 'Show', () =>
              store.updateItem(it.id, { visible: !it.visible }),
            ),
            iconBtn(it.locked ? 'lock' : 'unlock', it.locked ? 'Unlock' : 'Lock', () =>
              store.updateItem(it.id, { locked: !it.locked }),
            ),
          );
        }),
      );
    }
    const sel = store.selectedItemId;
    toolbar.replaceChildren(
      addBtn,
      toolBtn('trash', 'Remove source', () => sel && store.removeItem(sel), !sel),
      toolBtn('up', 'Move up (toward front)', () => sel && store.moveItem(sel, 1), !sel),
      toolBtn('down', 'Move down (toward back)', () => sel && store.moveItem(sel, -1), !sel),
    );
  };
  store.on('change', render);
  registry.on('change', render);
  render();
}

function addSourceMenu(studio: Studio): MenuEntry[] {
  const { registry, local, store } = studio;
  const videos = registry.list('video').sort((a, b) => Number(b.online) - Number(a.online));
  const entries: MenuEntry[] = [{ heading: 'Device sources' }];
  if (!videos.length) entries.push({ label: 'No video sources yet', disabled: true, onClick: () => {} });
  for (const v of videos) {
    entries.push({
      label: `${v.deviceName} · ${v.label}`,
      icon: v.type === 'screen' ? 'screen' : v.origin === 'remote' ? 'phone' : 'camera',
      sub: v.online ? 'live' : 'offline',
      onClick: () => studio.addInputItem(v.id),
    });
  }
  const capture = (fn: () => Promise<string>) => async () => {
    try {
      const id = await fn();
      studio.addInputItem(id);
    } catch (e) {
      if ((e as DOMException).name !== 'NotAllowedError' && (e as DOMException).name !== 'AbortError')
        toast(`Capture failed: ${errMsg(e)}`);
    }
  };
  const screen = (s: Surface) => capture(() => local.addScreen(s));
  entries.push(
    { sep: true },
    { heading: 'Capture on this computer' },
    { label: 'Webcam…', icon: 'camera', onClick: () => pickDevice(studio, 'videoinput') },
    { label: 'Entire screen', icon: 'screen', onClick: screen('monitor') },
    { label: 'Window', icon: 'screen', onClick: screen('window') },
    { label: 'Browser tab (with audio)', icon: 'screen', onClick: screen('browser') },
    { sep: true },
    { heading: 'Graphics' },
    { label: 'Image…', icon: 'image', onClick: () => addImage(studio) },
    {
      label: 'Text',
      icon: 'text',
      onClick: () =>
        store.addItem({
          name: 'Text',
          source: {
            type: 'text',
            text: 'Your title here',
            font: 'system-ui, sans-serif',
            size: 72,
            color: '#ffffff',
            bold: true,
            bg: '',
            align: 'left',
            outline: 0,
          },
          x: 120,
          y: 860,
          w: 560,
          h: 108,
          fit: 'stretch',
        }),
    },
    {
      label: 'Color block',
      icon: 'square',
      onClick: () =>
        store.addItem({
          name: 'Color',
          source: { type: 'color', color: '#1d2a44' },
          x: 0,
          y: 0,
          w: SCENE_W,
          h: SCENE_H,
        }),
    },
  );
  return entries;
}

export async function pickDevice(studio: Studio, kind: 'videoinput' | 'audioinput') {
  let devices = (await studio.local.devices()).filter((d) => d.kind === kind && d.deviceId);
  // Labels are hidden until permission is granted: ask once, then re-list.
  if (devices.length && !devices.some((d) => d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true } : { audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = (await studio.local.devices()).filter((d) => d.kind === kind && d.deviceId);
    } catch (e) {
      toast(`Permission denied: ${errMsg(e)}`);
      return;
    }
  }
  const add = async (deviceId?: string) => {
    close();
    try {
      if (kind === 'videoinput') studio.addInputItem(await studio.local.addWebcam(deviceId));
      else {
        await studio.local.addMic(deviceId);
        toast('Microphone added to the audio mixer');
      }
    } catch (e) {
      toast(`Could not open device: ${errMsg(e)}`);
    }
  };
  const list = h(
    'div.pick-list',
    null,
    ...(devices.length
      ? devices.map((d, i) =>
          h(
            'button.menu-item',
            { onclick: () => add(d.deviceId) },
            icon(kind === 'videoinput' ? 'camera' : 'mic'),
            d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`,
          ),
        )
      : [h('p', null, 'No devices found.')]),
  );
  const close = openModal(kind === 'videoinput' ? 'Add webcam' : 'Add microphone', list);
}

function addImage(studio: Studio) {
  const input = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const assetId = uid('a');
    await assets.put(assetId, file);
    const img = new Image();
    img.onload = () => {
      const box = fitBox(img.naturalWidth, img.naturalHeight, Math.min(SCENE_W, img.naturalWidth), Math.min(SCENE_H, img.naturalHeight));
      studio.store.addItem({ name: file.name.replace(/\.[^.]+$/, ''), source: { type: 'image', assetId, name: file.name }, ...box });
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };
  input.click();
}
