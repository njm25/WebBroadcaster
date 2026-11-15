import QRCode from 'qrcode';
import { icon } from '../../lib/icons';
import { joinUrl, type Room } from '../../lib/room';
import { disconnectDevice, newRoomCode } from './actions';
import { onPermissionChange, permissionState, requestMedia, type PermState } from '../permissions';
import { h } from '../../lib/util';
import type { Studio } from '../context';
import type { Input } from '../inputs';
import { remoteInputId, type RemoteDevice } from '../remote';
import { errMsg, iconBtn, openMenu, openModal, toast, type MenuEntry } from './common';
import { pickDevice } from './scenes-dock';

const STATE_DOT: Record<string, string> = {
  connected: 'ok',
  connecting: 'warn',
  new: 'warn',
  disconnected: 'warn',
  failed: 'bad',
  closed: 'bad',
};

export function mountDevices(studio: Studio, root: HTMLElement) {
  const { remote, registry, local } = studio;
  const box = h('div.devices');
  const toolbar = h('div.toolbar');
  root.append(box, toolbar);

  const thumbs = new Map<string, HTMLVideoElement>();
  const statEls = new Map<string, HTMLElement>();
  let signature = '';
  /** Selected entry: 'peer:<id>' (remote device), 'input:<id>' (local source) or 'offline:<deviceId>'. */
  let selected: string | null = null;
  const select = (key: string | null) => {
    selected = key;
    signature = '';
    render();
  };
  const selClass = (key: string) => (key === selected ? ' selected' : '');

  const thumb = (input: Input) => {
    let v = thumbs.get(input.id);
    if (!v) {
      v = h('video', { autoplay: true, muted: true, playsInline: true, class: 'src-thumb' }) as HTMLVideoElement;
      v.title = 'Add to scene';
      v.addEventListener('click', () => studio.addInputItem(input.id));
      thumbs.set(input.id, v);
    }
    if (v.srcObject !== input.stream) v.srcObject = input.stream;
    void v.play().catch(() => {});
    return v;
  };

  /** Thumbnail for live video, otherwise an icon tile the same height as the text. */
  const media = (input: Input | undefined, iconName: string) =>
    input?.kind === 'video' && input.stream && input.online ? thumb(input) : h('span.src-icon', null, icon(iconName));

  /** Name on the first line, details (stats / state) on a second, smaller line. */
  const srcText = (label: string, detail: HTMLElement | string, muted = false) =>
    h('div.src-text', null, h('div', { class: `lbl${muted ? ' muted' : ''}`, title: label }, label), typeof detail === 'string' ? h('div.stat', null, detail) : detail);

  function sourceRow(input: Input | undefined, label: string, kind: 'video' | 'audio', enabled: boolean, statKey: string) {
    const stat = h('div.stat', null, enabled ? '' : 'Off');
    if (enabled) statEls.set(statKey, stat);
    return h(
      'div.device-src',
      null,
      media(input, kind === 'video' ? (enabled ? 'camera' : 'cameraOff') : enabled ? 'mic' : 'micOff'),
      srcText(label, stat, !enabled),
      kind === 'video' && input ? iconBtn('plus', 'Add to current scene', () => studio.addInputItem(input.id)) : null,
    );
  }

  const STATE_TEXT: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting…',
    new: 'Connecting…',
    disconnected: 'Reconnecting…',
    failed: 'Connection failed',
    closed: 'Disconnected',
  };

  function deviceCard(dev: RemoteDevice) {
    const { peer, link } = dev;
    const sources = peer.state.sources ?? [];
    const cam = sources.find((s) => s.key === 'camera');
    const mic = sources.find((s) => s.key === 'mic');
    const ctl = (action: Parameters<typeof remote.control>[1]) => remote.control(peer.id, action);
    const more = h('button.item-btn', { title: 'More', 'aria-label': 'More' }, icon('gear'));
    more.addEventListener('click', () =>
      openMenu(more, [
        { heading: 'Camera quality' },
        { label: '720p', onClick: () => ctl({ action: 'setQuality', value: '720p' }) },
        { label: '1080p', onClick: () => ctl({ action: 'setQuality', value: '1080p' }) },
        { label: '4K', onClick: () => ctl({ action: 'setQuality', value: '4k' }) },
        { sep: true },
        {
          label: 'Disconnect device',
          icon: 'logout',
          onClick: () => void disconnectDevice(studio, peer.id),
        },
      ]),
    );
    const key = `peer:${peer.id}`;
    return h(
      'div.device',
      { class: `device${selClass(key)}`, onclick: () => select(key), 'data-peer-id': peer.id },
      h(
        'div.device-head',
        null,
        h('span', { class: `dot ${STATE_DOT[link.state] ?? ''}` }),
        h(
          'div.dev-title',
          null,
          h('div.name', { title: peer.name }, peer.name),
          h(
            'div.dev-sub',
            null,
            [STATE_TEXT[link.state] ?? link.state, peer.info.platform && peer.info.platform !== peer.name ? peer.info.platform : '']
              .filter(Boolean)
              .join(' · '),
          ),
        ),
        h(
          'div.device-actions',
          null,
          iconBtn(cam?.enabled ? 'camera' : 'cameraOff', cam?.enabled ? 'Turn camera off' : 'Turn camera on', () =>
            ctl({ action: 'setCamera', value: !cam?.enabled }),
          ),
          iconBtn('flip', 'Switch front/back camera', () => ctl({ action: 'flipCamera' })),
          iconBtn(mic?.enabled ? 'mic' : 'micOff', mic?.enabled ? 'Mute device mic' : 'Unmute device mic', () =>
            ctl({ action: 'setMic', value: !mic?.enabled }),
          ),
          more,
        ),
      ),
      ...sources.map((s) => {
        const id = remoteInputId(peer.deviceId, s.key);
        return sourceRow(registry.get(id), s.label, s.kind, s.enabled, `${peer.id}:${s.key}`);
      }),
      link.state === 'failed' ? h('div.dev-note', null, 'Reconnect the device to try again.') : null,
    );
  }

  function localCard(inputs: Input[]) {
    return h(
      'div.device',
      null,
      h(
        'div.device-head',
        null,
        h('span', { class: 'dot ok' }),
        h('div.dev-title', null, h('div.name', null, 'This computer'), h('div.dev-sub', null, `${inputs.length} source${inputs.length === 1 ? '' : 's'}`)),
      ),
      ...inputs.map((i) =>
        h(
          'div.device-src',
          {
            class: `device-src selectable${selClass(`input:${i.id}`)}`,
            onclick: (e: Event) => {
              e.stopPropagation();
              select(`input:${i.id}`);
            },
            'data-input-id': i.id,
          },
          media(i, i.kind === 'video' ? (i.type === 'screen' ? 'screen' : 'camera') : 'mic'),
          srcText(
            i.label,
            i.online ? (i.kind === 'video' ? (i.type === 'screen' ? 'Screen capture' : 'Webcam') : 'Microphone') : 'Offline',
            !i.online,
          ),
          i.online
            ? null
            : iconBtn('refresh', 'Reconnect', () =>
                local.reconnect(i.id).catch((e) => toast(`Reconnect failed: ${errMsg(e)}`)),
              ),
          i.kind === 'video' ? iconBtn('plus', 'Add to current scene', () => studio.addInputItem(i.id)) : null,
          iconBtn('trash', 'Remove', () => local.remove(i.id)),
        ),
      ),
    );
  }

  function render() {
    const devices = [...remote.devices.values()];
    const liveDeviceIds = new Set(devices.map((d) => d.peer.deviceId));
    const locals = registry.list().filter((i) => i.origin === 'local');
    const offline = registry.list().filter((i) => i.origin === 'remote' && !liveDeviceIds.has(i.deviceId));
    const sig = JSON.stringify([
      devices.map((d) => [
        d.peer.id,
        d.peer.name,
        d.link.state,
        d.peer.state.sources,
        [...d.streams.keys()],
        (d.peer.state.sources ?? []).map((s) => registry.get(remoteInputId(d.peer.deviceId, s.key))?.online),
      ]),
      locals.map((i) => [i.id, i.label, i.online, !!i.stream]),
      offline.map((i) => i.id),
      perm,
      selected,
    ]);
    if (sig !== signature) {
      signature = sig;
      statEls.clear();
      const children: (Node | string)[] = [];
      const card = permissionCard();
      if (card) children.push(card);
      children.push(...devices.map(deviceCard));
      if (locals.length) children.push(localCard(locals));
      if (offline.length) {
        const byDevice = new Map<string, Input[]>();
        for (const i of offline) byDevice.set(i.deviceId, [...(byDevice.get(i.deviceId) ?? []), i]);
        for (const inputs of byDevice.values()) {
          children.push(
            h(
              'div.device',
              {
                class: `device offline${selClass(`offline:${inputs[0].deviceId}`)}`,
                onclick: () => select(`offline:${inputs[0].deviceId}`),
                'data-device-id': inputs[0].deviceId,
              },
              h(
                'div.device-head',
                null,
                h('span.dot'),
                h(
                  'div.dev-title',
                  null,
                  h('div.name', null, inputs[0].deviceName),
                  h('div.dev-sub', null, `Offline · ${inputs.map((i) => i.label).join(', ')}`),
                ),
                iconBtn('trash', 'Forget device', () => {
                  for (const i of inputs) registry.remove(i.id);
                }),
              ),
            ),
          );
        }
      }
      if (!devices.length && !locals.length) {
        children.unshift(
          h(
            'div.list-empty',
            null,
            'No devices connected.',
          ),
        );
      }
      box.replaceChildren(...children);
      for (const [id, v] of thumbs) if (!v.isConnected) thumbs.delete(id);
    }
    renderToolbar();
    // Update stats in place.
    for (const d of devices) {
      for (const s of d.peer.state.sources ?? []) {
        const el = statEls.get(`${d.peer.id}:${s.key}`);
        const st = d.stats.get(s.key);
        if (!el) continue;
        const parts: string[] = [];
        if (st?.width && st.height) parts.push(`${st.width}×${st.height}`);
        if (st?.fps) parts.push(`${Math.round(st.fps)}fps`);
        if (st?.kbps !== undefined) parts.push(st.kbps >= 1000 ? `${(st.kbps / 1000).toFixed(1)}Mb/s` : `${st.kbps}kb/s`);
        el.textContent = parts.join(' · ');
      }
    }
  }

  // Toolbar: + (connect / add) and trash (remove selected), like Scenes and Sources.
  const addBtn = h('button.btn.ghost', { title: 'Add a device', 'aria-label': 'Add a device' }, icon('plus')) as HTMLButtonElement;
  addBtn.addEventListener('click', () => openMenu(addBtn, addDeviceMenu(studio)));
  const trashBtn = h('button.btn.ghost', { 'aria-label': 'Remove selected device' }, icon('trash')) as HTMLButtonElement;
  trashBtn.addEventListener('click', () => {
    if (selected) removeDeviceEntry(studio, selected);
  });
  toolbar.append(addBtn, trashBtn);
  function renderToolbar() {
    if (selected && !entryExists(studio, selected)) selected = null; // device went away
    trashBtn.disabled = !selected;
    trashBtn.title = selected ? removeLabel(studio, selected) : 'Select a device to remove it';
  }

  // ---- this computer's camera/mic permission ----
  let perm: { camera: PermState; microphone: PermState } = { camera: 'unknown', microphone: 'unknown' };
  let busy = false;
  const refreshPerm = async () => {
    perm = { camera: await permissionState('camera'), microphone: await permissionState('microphone') };
    render();
  };

  /** Prompt card shown until camera and mic are allowed (or explains how to unblock them). */
  function permissionCard(): HTMLElement | null {
    const states = [perm.camera, perm.microphone];
    if (states.every((s) => s === 'granted') || states.includes('unknown')) return null;
    const denied = states.includes('denied');
    const what =
      perm.camera !== 'granted' && perm.microphone !== 'granted'
        ? 'camera and microphone'
        : perm.camera !== 'granted'
          ? 'camera'
          : 'microphone';
    const allow = h(
      'button.btn.sm.primary',
      {
        disabled: busy,
        onclick: async () => {
          busy = true;
          signature = '';
          render();
          const res = await requestMedia({ video: perm.camera !== 'granted', audio: perm.microphone !== 'granted' });
          busy = false;
          if (!res.ok) {
            openModal('Camera & microphone access', h('p', null, res.message));
          } else {
            toast('Access allowed. Add a webcam or microphone with the + button under Sources.');
            void local.restore();
          }
          signature = '';
          await refreshPerm();
        },
      },
      icon('camera'),
      denied ? 'Try again' : `Allow ${what}`,
    );
    return h(
      'div.device.perm-card',
      null,
      h('div.device-head', null, h('span', { class: `dot ${denied ? 'bad' : 'warn'}` }), h('span.name', null, 'This computer')),
      h(
        'div.perm-text',
        null,
        denied
          ? `The ${what} ${what.includes('and') ? 'are' : 'is'} blocked for this site. Click the icon at the left of the address bar, set them to "Allow", then press Try again.`
          : `To use this computer's ${what} in the studio (webcam, local mic), allow access.`,
      ),
      h('div.device-actions', null, allow),
    );
  }

  onPermissionChange(() => {
    signature = '';
    void refreshPerm();
  });
  void refreshPerm();

  remote.on('change', render);
  registry.on('change', render);
  render();
}

/** Relay mode (page hosted on the internet): one QR with the room link. */
async function showRelayConnect(studio: Studio, room: Room) {
  const url = joinUrl(room);
  const img = h('img', { alt: 'QR code for the join link' }) as HTMLImageElement;
  img.src = await QRCode.toDataURL(url, { margin: 1, width: 440, errorCorrectionLevel: 'M' });
  const close = openModal(
    'Connect a device',
    h(
      'div.join-qr',
      null,
      h('div.qr-col', null, img, h('div.qr-caption', null, `Room ${room.id}`)),
      h(
        'div',
        null,
        h('p', null, 'Scan with a phone on the same Wi-Fi network as this computer.'),
        h(
          'div.url-list',
          null,
          h(
            'button.btn.sm.url-btn',
            {
              title: 'Copy the join link',
              onclick: () => void navigator.clipboard?.writeText(url).then(() => toast('Join link copied')),
            },
            h('span', null, 'Copy join link'),
            h('small', null, 'Anyone with this link can join while on your network. Share it only with your devices.'),
          ),
        ),
        h(
          'p',
          null,
          'Video and audio go directly between devices on your network. Only the short, encrypted connection setup passes through public relays (',
          sigLabel(studio),
          ').',
        ),
      ),
    ),
    h(
      'ol',
      null,
      h('li', null, 'Open the link on the phone, enter a device name and tap ', h('strong', null, 'Connect'), ', then allow camera and microphone.'),
      h('li', null, 'The device appears in the Devices panel. Click its preview (or +) to add it to the scene.'),
      h('li', null, 'Devices must be on the same network as this computer; connections over the internet are refused.'),
    ),
    h(
      'div.modal-actions',
      null,
      h(
        'button.btn.sm.danger',
        {
          title: 'Invalidate the current join link',
          onclick: async () => {
            if (await newRoomCode()) close();
          },
        },
        'New room code',
      ),
    ),
  );
}

const sigLabel = (studio: Studio) => studio.sig.label;

export async function showConnect(studio: Studio) {
  if (studio.room) return showRelayConnect(studio, studio.room);
  const isLocalhost = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  // Server lists local-network addresses before VPN (e.g. Tailscale) ones.
  const entries = studio.sig.lanUrls.map((u) => ({ ...u, url: `${u.url}/source` }));
  if (!isLocalhost && !entries.some((e) => e.url.startsWith(location.origin))) {
    entries.unshift({ url: `${location.origin}/source`, kind: 'lan', label: 'Address you opened the studio with' });
  }
  const img = h('img', { alt: 'QR code for the join URL' }) as HTMLImageElement;
  const buttons: HTMLButtonElement[] = [];
  const showQr = async (url: string, selected = -1) => {
    img.src = await QRCode.toDataURL(url, { margin: 1, width: 400, errorCorrectionLevel: 'M' });
    buttons.forEach((b, j) => b.classList.toggle('on', j === selected));
  };
  const select = async (i: number) => {
    const e = entries[i];
    if (e) await showQr(e.url, i);
  };
  const lan = entries.filter((e) => e.kind === 'lan');
  openModal(
    'Connect a device',
    h(
      'div.join-qr',
      null,
      h('div.qr-col', null, img),
      h(
        'div',
        null,
        h('p', null, 'Scan with a phone on the same Wi-Fi network as this computer, or open a link on any device:'),
        h(
          'div.url-list',
          null,
          ...entries.map((e, i) => {
            const b = h(
              'button.btn.sm.url-btn',
              {
                title: 'Show this address as the QR code and copy it',
                onclick: () => {
                  void select(i);
                  void navigator.clipboard?.writeText(e.url).then(() => toast('Link copied'));
                },
              },
              h('span', null, e.url),
            ) as HTMLButtonElement;
            buttons.push(b);
            return b;
          }),
        ),
      ),
    ),
    !lan.length && entries.length
      ? h('p', null, 'No local-network address was found, only VPN addresses. Check that this computer is connected to Wi-Fi or Ethernet.')
      : '',
    h(
      'ol',
      null,
      h('li', null, 'Open the link on the phone, enter a device name and tap ', h('strong', null, 'Connect'), ', then allow camera and microphone.'),
      h('li', null, 'The device appears in the Devices panel. Click its preview (or +) to add it to the scene.'),
    ),
    entries.length ? '' : h('p', null, 'No network address detected. Make sure this computer is connected to your network.'),
  );
  await select(0);
}

// ---------------------------------------------------------------- device actions
// Shared by the Devices toolbar and the right-click menus.

export function addDeviceMenu(studio: Studio): MenuEntry[] {
  return [
    { label: 'Connect a phone or device…', icon: 'qr', onClick: () => void showConnect(studio) },
    { sep: true },
    { label: 'Webcam on this computer…', icon: 'camera', onClick: () => void pickDevice(studio, 'videoinput') },
    { label: 'Microphone on this computer…', icon: 'mic', onClick: () => void pickDevice(studio, 'audioinput') },
  ];
}

const splitKey = (key: string) => {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)] as const;
};

const offlineInputs = (studio: Studio, deviceId: string) => {
  const live = [...studio.remote.devices.values()].some((d) => d.peer.deviceId === deviceId);
  return live ? [] : studio.registry.list().filter((i) => i.origin === 'remote' && i.deviceId === deviceId);
};

export function entryExists(studio: Studio, key: string) {
  const [kind, id] = splitKey(key);
  if (kind === 'peer') return studio.remote.devices.has(id);
  if (kind === 'input') return !!studio.registry.get(id);
  return offlineInputs(studio, id).length > 0;
}

export function removeLabel(studio: Studio, key: string) {
  const [kind, id] = splitKey(key);
  if (kind === 'peer') return `Disconnect "${studio.remote.devices.get(id)?.peer.name ?? 'device'}"`;
  if (kind === 'input') return `Remove "${studio.registry.get(id)?.label ?? 'source'}"`;
  return `Forget "${offlineInputs(studio, id)[0]?.deviceName ?? 'device'}"`;
}

export function removeDeviceEntry(studio: Studio, key: string) {
  const [kind, id] = splitKey(key);
  if (kind === 'peer') {
    void disconnectDevice(studio, id);
  } else if (kind === 'input') {
    studio.local.remove(id);
  } else {
    for (const i of offlineInputs(studio, id)) studio.registry.remove(i.id);
  }
}
