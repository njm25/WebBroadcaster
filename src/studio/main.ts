// Studio dashboard entry point: wires the engine modules to the UI.

import { signalMode, studioRoom } from '../lib/room';
import { createSignaling } from '../lib/signaling';
import { deviceInfo, loadJSON, persistentId, saveJSON } from '../lib/util';
import { Compositor } from './compositor';
import type { OutputSettings, Studio } from './context';
import { Editor } from './editor';
import { InputRegistry } from './inputs';
import { LocalSources } from './local';
import { Mixer } from './mixer';
import { Recorder } from './recorder';
import { RemoteManager } from './remote';
import { SCENE_H, SCENE_W, SceneStore, fitBox } from './scenes';
import { mountControls } from './ui/controls-ui';
import { mountDevices } from './ui/devices-ui';
import { mountMixer } from './ui/mixer-ui';
import { mountProps } from './ui/props';
import { mountScenesDock, mountSourcesDock } from './ui/scenes-dock';

const $ = (id: string) => document.getElementById(id)!;

export function startStudio() {
  const settings: OutputSettings = {
    width: 1920,
    height: 1080,
    fps: 30,
    formatId: 'mp4',
    videoBitrate: 12_000_000,
    toDisk: false,
    ...loadJSON<Partial<OutputSettings>>('wb.settings', {}),
  };

  const registry = new InputRegistry();
  const mode = signalMode();
  const room = mode === 'relay' ? studioRoom() : null;
  const sig = createSignaling(
    { role: 'studio', name: 'Studio', deviceId: persistentId('wb.studioId'), info: deviceInfo() },
    mode,
    room,
  );
  const remote = new RemoteManager(sig, registry);
  const local = new LocalSources(registry);
  const store = new SceneStore();
  const comp = new Compositor(store, registry);
  comp.setOutput(settings.width, settings.height, settings.fps);
  const editor = new Editor(store, comp, (it) => it.name);
  const mixer = new Mixer(registry);
  const recorder = new Recorder();

  const studio: Studio = {
    sig,
    room,
    registry,
    remote,
    local,
    store,
    comp,
    editor,
    mixer,
    recorder,
    settings,
    saveSettings() {
      saveJSON('wb.settings', settings);
      if (comp.width !== settings.width || comp.height !== settings.height || comp.fps !== settings.fps) {
        comp.setOutput(settings.width, settings.height, settings.fps);
        layout();
      }
    },
    addInputItem(inputId) {
      const input = registry.get(inputId);
      if (!input) return;
      const el = input.el instanceof HTMLVideoElement ? input.el : null;
      const w = el?.videoWidth || Number(input.meta?.width) || 1920;
      const h = el?.videoHeight || Number(input.meta?.height) || 1080;
      const scene = store.editing;
      const visible = scene.items.filter((i) => i.visible).length;
      // First source fills the canvas; later ones arrive as picture-in-picture.
      const box = visible === 0 ? fitBox(w, h) : pip(w, h, visible);
      store.addItem({
        name: input.origin === 'remote' ? `${input.deviceName} · ${input.label}` : input.label,
        source: { type: 'input', inputId },
        ...box,
      });
    },
  };

  // ---------- canvases & layout ----------
  const wrapProgram = $('wrap-program');
  const wrapPreview = $('wrap-preview');
  const views = $('views');
  wrapProgram.append(comp.canvas);
  wrapPreview.append(comp.previewCanvas);

  const placeOverlay = () => {
    views.classList.toggle('studio-mode', store.studioMode);
    const target = store.studioMode ? wrapPreview : wrapProgram;
    if (editor.overlay.parentElement !== target) target.append(editor.overlay);
    ($('studio-mode') as HTMLInputElement).checked = store.studioMode;
    layout();
  };

  function layout() {
    const aspect = settings.width / settings.height;
    for (const wrap of [wrapProgram, wrapPreview]) {
      const stage = wrap.parentElement!;
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (!sw || !sh) continue;
      const w = sw / sh > aspect ? sh * aspect : sw;
      wrap.style.width = `${Math.floor(w)}px`;
      wrap.style.height = `${Math.floor(w / aspect)}px`;
    }
  }
  new ResizeObserver(layout).observe(views);

  $('studio-mode').addEventListener('change', (e) => store.setStudioMode((e.target as HTMLInputElement).checked));
  $('take').addEventListener('click', () => store.take());
  store.on('change', placeOverlay);

  // ---------- panels ----------
  mountScenesDock(studio, $('dock-scenes'));
  mountSourcesDock(studio, $('dock-sources'));
  mountProps(studio, $('props'));
  mountMixer(studio, $('dock-mixer'));
  mountDevices(studio, $('dock-devices'));
  mountControls(studio, $('dock-controls'));
  placeOverlay();

  // ---------- top bar ----------
  const status = $('top-status');
  const recPill = $('rec-pill');
  const renderStatus = () => {
    const sigState = sig.status === 'open' ? 'ok' : sig.status === 'connecting' ? 'warn' : 'bad';
    const devCount = remote.devices.size;
    const live = [...remote.devices.values()].filter((d) => d.link.state === 'connected').length;
    status.innerHTML = '';
    const item = (dot: string | null, text: string, title = '') => {
      const s = document.createElement('span');
      s.title = title;
      if (dot) {
        const d = document.createElement('span');
        d.className = `dot ${dot}`;
        s.append(d);
      }
      s.append(text);
      status.append(s);
    };
    item(
      sigState,
      sig.label,
      sig.mode === 'relay'
        ? 'Encrypted public relays used only to set up connections; media stays on your network'
        : 'Local signaling server connection',
    );
    item(devCount ? (live === devCount ? 'ok' : 'warn') : null, `${live}/${devCount} devices`);
    item(null, `${settings.width}×${settings.height}`);
    item(comp.actualFps >= settings.fps - 2 ? null : 'warn', `${comp.actualFps}/${settings.fps} fps`, 'Render rate');
    const st = recorder.state;
    recPill.hidden = st === 'inactive';
    recPill.classList.toggle('paused', st === 'paused');
    recPill.textContent = st === 'paused' ? 'PAUSED' : `● REC ${new Date(recorder.elapsed).toISOString().slice(11, 19)}`;
  };
  setInterval(renderStatus, 500);
  sig.on('status', renderStatus);

  // ---------- audio unlock ----------
  const banner = $('audio-banner');
  const updateBanner = () => (banner.hidden = mixer.running);
  mixer.on('change', updateBanner);
  const unlock = () => {
    mixer.resume();
    registry.kick();
  };
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });
  $('audio-resume').addEventListener('click', unlock);
  updateBanner();

  // ---------- tally ----------
  let lastTally = '';
  const sendTally = (force = false) => {
    const program = store.inputsIn(store.program);
    const preview = store.studioMode ? store.inputsIn(store.find(store.previewId)) : new Set<string>();
    const rec = recorder.state !== 'inactive';
    const sigStr = JSON.stringify([[...program], [...preview], rec, [...remote.devices.keys()]]);
    if (!force && sigStr === lastTally) return;
    lastTally = sigStr;
    remote.sendTally(program, preview, rec);
  };
  store.on('change', () => sendTally());
  recorder.on('state', () => sendTally());
  remote.on('change', () => sendTally());

  // ---------- first-run convenience: show the first phone camera ----------
  let autoAdded = loadJSON('wb.autoAdded', false);
  registry.on('change', () => {
    if (autoAdded || store.scenes.some((s) => s.items.length)) return;
    const cam = registry.list('video').find((i) => i.origin === 'remote' && i.online);
    if (!cam) return;
    autoAdded = true;
    saveJSON('wb.autoAdded', true);
    studio.addInputItem(cam.id);
  });

  // ---------- auto-fit when a phone rotates ----------
  registry.on('resize', (input, w, h) => store.refitInput(input.id, w, h));

  // ---------- hotkeys ----------
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
    const sel = store.selectedItem;
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const scene = store.scenes[Number(e.key) - 1];
      if (scene) store.activate(scene.id);
      return;
    }
    if (e.key === 'Enter' && store.studioMode) {
      store.take();
      return;
    }
    if (e.key === 'Escape') return store.select(null);
    if (!sel) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !sel.locked) {
      e.preventDefault();
      store.removeItem(sel.id);
    }
    const step = e.shiftKey ? 10 : 1;
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (nudge[e.key] && !sel.locked) {
      e.preventDefault();
      const [dx, dy] = nudge[e.key];
      store.updateItem(sel.id, { x: sel.x + dx, y: sel.y + dy });
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (recorder.state !== 'inactive') e.preventDefault();
  });

  sig.connect();
  void local.restore();

  // Expose for debugging from the console.
  (window as unknown as { studio: Studio }).studio = studio;
}

/** Picture-in-picture box in the bottom-right, stacked upward for each extra source. */
function pip(w: number, h: number, index: number) {
  const maxW = SCENE_W * 0.3;
  const maxH = SCENE_H * 0.3;
  const s = Math.min(maxW / w, maxH / h);
  const bw = Math.round(w * s);
  const bh = Math.round(h * s);
  const margin = 40;
  const slot = (index - 1) % 3;
  return { x: SCENE_W - bw - margin, y: Math.max(margin, SCENE_H - bh - margin - slot * (bh + 20)), w: bw, h: bh };
}
