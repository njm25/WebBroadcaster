// Source device app: runs on phones/tablets/computers that contribute media
// to a studio. Publishes each media track in its own MediaStream (so the
// studio can mix them independently) to every connected studio dashboard.

import { icon } from '../lib/icons';
import { PeerLink, setMaxBitrate } from '../lib/peer';
import { QUALITY, type Facing, type PublishedSource, type QualityPreset, type RelayMsg } from '../lib/protocol';
import { roomFromHash, signalMode, type Room } from '../lib/room';
import { createSignaling, type SignalingLike } from '../lib/signaling';
import { deviceInfo, h, loadJSON, persistentId, saveJSON } from '../lib/util';

type Key = 'camera' | 'mic' | 'screen' | 'screen-audio';

interface Publication {
  key: Key;
  kind: 'video' | 'audio';
  stream: MediaStream; // stable stream object -> stable msid at the studio
  track: MediaStreamTrack | null;
  label: string;
  used: boolean;
}

interface StudioLink {
  link: PeerLink;
  senders: Map<Key, RTCRtpSender>;
}

interface Settings {
  name: string;
  facing: Facing;
  cameraId: string;
  micId: string;
  quality: QualityPreset;
  processing: boolean;
  wantCam: boolean;
  wantMic: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function startSourceApp() {
  const info = deviceInfo();
  const deviceId = persistentId('wb.deviceId');
  const settings: Settings = {
    name: info.platform,
    facing: 'user',
    cameraId: '',
    micId: '',
    quality: '1080p',
    processing: false,
    wantCam: true,
    wantMic: true,
    ...loadJSON<Partial<Settings>>('wb.source.settings', {}),
  };
  const persist = () => saveJSON('wb.source.settings', settings);

  const app = $('app');
  const setView = (v: 'join' | 'live' | 'ended') => (app.dataset.view = v);

  const pubs: Record<Key, Publication> = {
    camera: { key: 'camera', kind: 'video', stream: new MediaStream(), track: null, label: 'Camera', used: false },
    mic: { key: 'mic', kind: 'audio', stream: new MediaStream(), track: null, label: 'Microphone', used: false },
    screen: { key: 'screen', kind: 'video', stream: new MediaStream(), track: null, label: 'Screen', used: false },
    'screen-audio': {
      key: 'screen-audio',
      kind: 'audio',
      stream: new MediaStream(),
      track: null,
      label: 'Screen audio',
      used: false,
    },
  };
  const links = new Map<string, StudioLink>();
  let sig: SignalingLike | null = null;
  let wakeLock: { release(): Promise<void> } | null = null;
  let audioCtx: AudioContext | null = null;
  let meterSource: MediaStreamAudioSourceNode | null = null;
  let cameraLost = false;
  const analyser = { node: null as AnalyserNode | null, buf: new Float32Array(1024) };

  // ---------- Join screen ----------
  const nameInput = $<HTMLInputElement>('name');
  nameInput.value = settings.name;
  $<HTMLInputElement>('opt-cam').checked = settings.wantCam;
  $<HTMLInputElement>('opt-mic').checked = settings.wantMic;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) $('secure-hint').hidden = false;

  // How to find the studio: local server, or encrypted relays + the room from the join link.
  const mode = signalMode();
  let room: Room | null = null;
  if (mode === 'relay') {
    room = roomFromHash() ?? loadJSON<Room | null>('wb.source.room', null);
    if (room) saveJSON('wb.source.room', room);
    else {
      $<HTMLButtonElement>('join').disabled = true;
      const err = $('join-error');
      err.textContent = "Open this page by scanning the QR code in the studio's \"Connect a device\" dialog.";
      err.hidden = false;
    }
  }

  $('join').addEventListener('click', join);
  $('rejoin').addEventListener('click', join);

  async function join() {
    settings.name = nameInput.value.trim() || info.platform;
    settings.wantCam = $<HTMLInputElement>('opt-cam').checked;
    settings.wantMic = $<HTMLInputElement>('opt-mic').checked;
    persist();
    const err = $('join-error');
    err.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      err.textContent = 'Camera/microphone access is unavailable. The page must be opened over HTTPS.';
      err.hidden = false;
      return;
    }
    // Create the audio context inside the user gesture (required on iOS).
    try {
      audioCtx ??= new AudioContext();
      await audioCtx.resume();
    } catch {
      /* metering is optional */
    }

    try {
      if (settings.wantCam) await startCamera();
      if (settings.wantMic) await startMic();
    } catch (e) {
      err.textContent = `Could not access media: ${(e as Error).message || e}`;
      err.hidden = false;
      stopAll();
      return;
    }

    setView('live');
    connectSignaling();
    requestWakeLock();
    refreshDeviceLists();
    renderControls();
  }

  // ---------- Media ----------
  function cameraConstraints(): MediaTrackConstraints {
    const q = QUALITY[settings.quality];
    const c: MediaTrackConstraints = {
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: 30 },
    };
    if (settings.cameraId) c.deviceId = { exact: settings.cameraId };
    else c.facingMode = { ideal: settings.facing };
    return c;
  }

  async function startCamera() {
    // Stop the old track first: iOS can't open two cameras at once.
    publish('camera', null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(), audio: false });
    } catch (e) {
      if (settings.cameraId) {
        settings.cameraId = '';
        stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(), audio: false });
      } else throw e;
    }
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    if (s.facingMode === 'user' || s.facingMode === 'environment') settings.facing = s.facingMode;
    track.contentHint = 'motion';
    track.addEventListener('ended', () => {
      if (pubs.camera.track === track) {
        cameraLost = true; // e.g. iOS stopped it while the page was in the background
        publish('camera', null);
      }
    });
    cameraLost = false;
    publish('camera', track);
  }

  async function startMic() {
    publish('mic', null);
    const p = settings.processing;
    const audio: MediaTrackConstraints = {
      echoCancellation: p,
      noiseSuppression: p,
      autoGainControl: p,
      channelCount: { ideal: 2 },
    };
    if (settings.micId) audio.deviceId = { exact: settings.micId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      if (pubs.mic.track === track) publish('mic', null);
    });
    publish('mic', track);
  }

  async function startScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    const v = stream.getVideoTracks()[0];
    const a = stream.getAudioTracks()[0] ?? null;
    v.contentHint = 'detail';
    v.addEventListener('ended', () => {
      if (pubs.screen.track === v) {
        publish('screen', null);
        publish('screen-audio', null);
      }
    });
    publish('screen', v);
    publish('screen-audio', a);
  }

  /** Swap the live track for `key` on every studio connection. */
  function publish(key: Key, track: MediaStreamTrack | null) {
    const pub = pubs[key];
    const old = pub.track;
    if (old && old !== track) {
      pub.stream.removeTrack(old);
      old.stop();
    }
    if (track && !pub.stream.getTracks().includes(track)) pub.stream.addTrack(track);
    pub.track = track;
    if (track) {
      pub.used = true;
      pub.label = labelFor(key, track);
    }
    for (const l of links.values()) syncSender(l, key);
    if (key === 'camera') renderPreview();
    if (key === 'mic') attachMeter();
    pushState();
    renderControls();
  }

  function labelFor(key: Key, track: MediaStreamTrack) {
    if (key === 'camera') {
      const f = track.getSettings().facingMode;
      if (f === 'environment') return 'Back camera';
      if (f === 'user') return 'Front camera';
      return track.label && track.label.length <= 48 && /\s/.test(track.label) ? track.label : 'Camera';
    }
    if (key === 'mic') return track.label && !/^default$/i.test(track.label) ? track.label : 'Microphone';
    if (key === 'screen') return 'Screen share';
    return 'Screen audio';
  }

  function syncSender(l: StudioLink, key: Key) {
    const pub = pubs[key];
    const sender = l.senders.get(key);
    if (sender) {
      sender.replaceTrack(pub.track).catch((e) => console.warn('replaceTrack failed', e));
    } else if (pub.track) {
      l.senders.set(key, l.link.pc.addTrack(pub.track, pub.stream));
    }
    applyBitrates(l);
  }

  function applyBitrates(l: StudioLink) {
    const cam = l.senders.get('camera');
    if (cam) void setMaxBitrate(cam, QUALITY[settings.quality].bitrate);
    const scr = l.senders.get('screen');
    if (scr) void setMaxBitrate(scr, 8_000_000);
  }

  function stopAll() {
    for (const key of Object.keys(pubs) as Key[]) publish(key, null);
  }

  // ---------- Signaling & peers ----------
  let studioIds = new Set<string>();

  function connectSignaling() {
    sig?.close();
    sig = createSignaling({ role: 'source', name: settings.name, deviceId, info }, mode, room);
    sig.on('status', renderStatus);
    sig.on('peers', (peers) => {
      studioIds = new Set(peers.filter((p) => p.role === 'studio').map((p) => p.id));
      for (const id of studioIds) if (!links.has(id)) createLink(id);
      pruneLinks();
      renderStatus();
    });
    sig.on('relay', (from, msg) => onRelay(from, msg));
    pushState();
    sig.connect();
  }

  /** Drop links to studios that left — but never a link that's still directly connected. */
  function pruneLinks() {
    for (const [id, l] of links) {
      if (!studioIds.has(id) && !l.link.alive) {
        links.delete(id); // before close(): its 'closed' event must not re-enter
        l.link.close();
      }
    }
  }

  function createLink(studioId: string) {
    const link = new PeerLink(studioId, false, (msg) => sig?.relay(studioId, msg));
    const l: StudioLink = { link, senders: new Map() };
    links.set(studioId, l);
    link.on('state', (s) => {
      if (s === 'connected') applyBitrates(l);
      if (s === 'failed' || s === 'closed' || !link.alive) pruneLinks();
      renderStatus();
    });
    link.on('message', (msg) => onRelay(studioId, msg));
    for (const key of Object.keys(pubs) as Key[]) syncSender(l, key);
  }

  function onRelay(from: string, msg: RelayMsg) {
    if (msg.kind === 'rtc') {
      void links.get(from)?.link.handle(msg);
    } else if (msg.kind === 'control') {
      void handleControl(msg);
    } else if (msg.kind === 'tally') {
      const program = msg.program.some((k) => k === 'camera' || k === 'screen');
      const preview = !program && msg.preview.some((k) => k === 'camera' || k === 'screen');
      const t = $('tally');
      t.classList.toggle('program', program);
      t.classList.toggle('preview', preview);
      $('badge-live').hidden = !program;
      $('badge-pvw').hidden = !preview;
      $('badge-rec').hidden = !msg.recording;
    }
  }

  async function handleControl(msg: Extract<RelayMsg, { kind: 'control' }>) {
    try {
      switch (msg.action) {
        case 'setCamera':
          if (msg.value && !pubs.camera.track) await startCamera();
          else if (!msg.value) publish('camera', null);
          break;
        case 'setMic':
          if (msg.value && !pubs.mic.track) await startMic();
          else if (!msg.value) publish('mic', null);
          break;
        case 'flipCamera':
          await flipCamera();
          break;
        case 'setQuality':
          settings.quality = msg.value;
          persist();
          if (pubs.camera.track) await startCamera();
          break;
        case 'disconnect':
          leave('Disconnected by studio', 'The studio operator removed this device.');
          break;
      }
    } catch (e) {
      console.warn('control failed', e);
    }
  }

  function pushState() {
    const sources: PublishedSource[] = (Object.values(pubs) as Publication[])
      .filter((p) => p.used)
      .map((p) => {
        const s = p.track?.getSettings();
        return {
          key: p.key,
          kind: p.kind,
          streamId: p.stream.id,
          label: p.label,
          enabled: !!p.track && p.track.readyState === 'live',
          facing: p.key === 'camera' ? settings.facing : undefined,
          width: s?.width,
          height: s?.height,
          frameRate: s?.frameRate ? Math.round(s.frameRate) : undefined,
        };
      });
    sig?.setState({
      sources,
      canSwitchCamera: true,
      canShareScreen: canShareScreen(),
    });
  }

  function leave(title = 'Disconnected', message = 'You left the studio.') {
    const all = [...links.values()];
    links.clear();
    for (const l of all) l.link.close();
    sig?.close();
    sig = null;
    stopAll();
    for (const p of Object.values(pubs)) p.used = false;
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    $('ended-title').textContent = title;
    $('ended-msg').textContent = message;
    setView('ended');
  }

  // ---------- Camera helpers ----------
  async function flipCamera() {
    settings.facing = settings.facing === 'user' ? 'environment' : 'user';
    settings.cameraId = '';
    persist();
    await startCamera();
    refreshDeviceLists();
  }

  const canShareScreen = () => !info.mobile && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  // ---------- UI ----------
  const preview = $<HTMLVideoElement>('preview');
  function renderPreview() {
    const track = pubs.camera.track ?? pubs.screen.track;
    preview.srcObject = track ? new MediaStream([track]) : null;
    if (track) void preview.play().catch(() => {});
    const stage = $('stage');
    stage.classList.toggle('cam-off', !track);
    stage.classList.toggle('mirror', !!pubs.camera.track && settings.facing === 'user');
  }

  function renderStatus() {
    const dot = $('status').querySelector('.dot')!;
    const text = $('status-text');
    dot.className = 'dot';
    if (!sig || sig.status !== 'open') {
      dot.classList.add('warn');
      text.textContent = 'Connecting to server…';
      return;
    }
    const all = [...links.values()];
    const connected = all.filter((l) => l.link.state === 'connected').length;
    if (!all.length) {
      dot.classList.add('warn');
      text.textContent = 'Waiting for studio…';
    } else if (connected) {
      dot.classList.add('ok');
      text.textContent = `${settings.name} · connected${connected > 1 ? ` to ${connected} studios` : ''}`;
    } else {
      dot.classList.add('warn');
      text.textContent = 'Connecting to studio…';
    }
  }

  const btn = {
    cam: $<HTMLButtonElement>('btn-cam'),
    flip: $<HTMLButtonElement>('btn-flip'),
    mic: $<HTMLButtonElement>('btn-mic'),
    screen: $<HTMLButtonElement>('btn-screen'),
    settings: $<HTMLButtonElement>('btn-settings'),
    leave: $<HTMLButtonElement>('btn-leave'),
  };
  btn.flip.replaceChildren(icon('flip'));
  btn.settings.replaceChildren(icon('gear'));
  btn.leave.replaceChildren(icon('logout'));
  btn.screen.replaceChildren(icon('screen'));
  btn.screen.hidden = !canShareScreen();
  $('sheet-close').replaceChildren(icon('x'));

  function renderControls() {
    const camOn = !!pubs.camera.track;
    const micOn = !!pubs.mic.track;
    btn.cam.replaceChildren(icon(camOn ? 'camera' : 'cameraOff'));
    btn.cam.classList.toggle('off', !camOn);
    btn.mic.replaceChildren(icon(micOn ? 'mic' : 'micOff'));
    btn.mic.classList.toggle('off', !micOn);
    btn.flip.disabled = !camOn;
    btn.screen.classList.toggle('off', !!pubs.screen.track);
    $('meter-wrap').style.visibility = micOn ? 'visible' : 'hidden';
  }

  const guard = (fn: () => Promise<void>) => () =>
    fn().catch((e) => alert(`Couldn't change media: ${(e as Error).message || e}`));

  btn.cam.addEventListener(
    'click',
    guard(async () => (pubs.camera.track ? publish('camera', null) : await startCamera())),
  );
  btn.mic.addEventListener(
    'click',
    guard(async () => (pubs.mic.track ? publish('mic', null) : await startMic())),
  );
  btn.flip.addEventListener('click', guard(flipCamera));
  btn.screen.addEventListener(
    'click',
    guard(async () => {
      if (pubs.screen.track) {
        publish('screen', null);
        publish('screen-audio', null);
      } else await startScreen();
    }),
  );
  btn.leave.addEventListener('click', () => leave());

  // Settings sheet
  const sheet = $('sheet');
  btn.settings.addEventListener('click', () => {
    $<HTMLInputElement>('set-name').value = settings.name;
    $<HTMLSelectElement>('set-quality').value = settings.quality;
    $<HTMLInputElement>('set-processing').checked = settings.processing;
    refreshDeviceLists();
    sheet.hidden = false;
  });
  $('sheet-close').addEventListener('click', () => (sheet.hidden = true));
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.hidden = true;
  });
  $<HTMLInputElement>('set-name').addEventListener('change', (e) => {
    settings.name = (e.target as HTMLInputElement).value.trim() || info.platform;
    persist();
    sig?.setName(settings.name);
    renderStatus();
  });
  $<HTMLSelectElement>('set-quality').addEventListener('change', (e) => {
    settings.quality = (e.target as HTMLSelectElement).value as QualityPreset;
    persist();
    if (pubs.camera.track) guard(startCamera)();
  });
  $<HTMLSelectElement>('set-camera').addEventListener('change', (e) => {
    settings.cameraId = (e.target as HTMLSelectElement).value;
    persist();
    guard(startCamera)();
  });
  $<HTMLSelectElement>('set-mic').addEventListener('change', (e) => {
    settings.micId = (e.target as HTMLSelectElement).value;
    persist();
    guard(startMic)();
  });
  $<HTMLInputElement>('set-processing').addEventListener('change', (e) => {
    settings.processing = (e.target as HTMLInputElement).checked;
    persist();
    if (pubs.mic.track) guard(startMic)();
  });

  async function refreshDeviceLists() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (sel: HTMLSelectElement, kind: MediaDeviceKind, current: string, autoLabel: string) => {
        const list = devices.filter((d) => d.kind === kind && d.deviceId);
        sel.replaceChildren(
          h('option', { value: '' }, autoLabel),
          ...list.map((d, i) => h('option', { value: d.deviceId }, d.label || `${kind} ${i + 1}`)),
        );
        sel.value = list.some((d) => d.deviceId === current) ? current : '';
      };
      fill(
        $('set-camera'),
        'videoinput',
        settings.cameraId,
        settings.facing === 'user' ? 'Automatic (front)' : 'Automatic (back)',
      );
      fill($('set-mic'), 'audioinput', settings.micId, 'Default microphone');
    } catch {
      /* ignore */
    }
  }

  // Local mic meter
  function attachMeter() {
    meterSource?.disconnect();
    meterSource = null;
    const track = pubs.mic.track;
    if (!track || !audioCtx) return;
    analyser.node ??= Object.assign(audioCtx.createAnalyser(), { fftSize: 1024 });
    meterSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
    meterSource.connect(analyser.node);
  }
  const meter = $('meter');
  (function meterLoop() {
    requestAnimationFrame(meterLoop);
    if (!analyser.node || !pubs.mic.track) return;
    analyser.node.getFloatTimeDomainData(analyser.buf);
    let peak = 0;
    for (const v of analyser.buf) peak = Math.max(peak, Math.abs(v));
    const db = 20 * Math.log10(peak || 1e-6);
    meter.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  })();

  // Keep the screen awake while streaming.
  async function requestWakeLock() {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } })
        .wakeLock;
      if (wl && app.dataset.view === 'live') wakeLock = await wl.request('screen');
    } catch {
      /* not supported or denied */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.dataset.view === 'live') {
      void requestWakeLock();
      void audioCtx?.resume();
      // iOS may have killed the camera while backgrounded; bring it back.
      if (cameraLost && !pubs.camera.track) {
        guard(startCamera)();
      }
    }
  });
  window.addEventListener('pagehide', () => sig?.close());
}
