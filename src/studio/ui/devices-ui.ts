import QRCode from 'qrcode';
import { icon } from '../../lib/icons';
import { joinUrl, resetStudioRoom, type Room } from '../../lib/room';
import { h } from '../../lib/util';
import type { Studio } from '../context';
import type { Input } from '../inputs';
import { remoteInputId, type RemoteDevice } from '../remote';
import { errMsg, iconBtn, openMenu, openModal, toast } from './common';
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

  const thumb = (input: Input) => {
    let v = thumbs.get(input.id);
    if (!v) {
      v = h('video', { autoplay: true, muted: true, playsInline: true }) as HTMLVideoElement;
      Object.assign(v.style, {
        width: '96px',
        height: '54px',
        objectFit: 'contain',
        background: '#000',
        borderRadius: '4px',
        flex: 'none',
        cursor: 'pointer',
      });
      v.title = 'Add to scene';
      v.addEventListener('click', () => studio.addInputItem(input.id));
      thumbs.set(input.id, v);
    }
    if (v.srcObject !== input.stream) v.srcObject = input.stream;
    void v.play().catch(() => {});
    return v;
  };

  function sourceRow(input: Input | undefined, label: string, kind: 'video' | 'audio', enabled: boolean, statKey: string) {
    const stat = h('span.stat');
    statEls.set(statKey, stat);
    return h(
      'div.device-src',
      null,
      kind === 'video' && input?.stream && input.online ? thumb(input) : icon(kind === 'video' ? (enabled ? 'camera' : 'cameraOff') : enabled ? 'mic' : 'micOff'),
      h('span.lbl', null, label),
      enabled ? null : h('span', null, '(off)'),
      stat,
      kind === 'video' && input ? iconBtn('plus', 'Add to current scene', () => studio.addInputItem(input.id)) : null,
    );
  }

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
          onClick: () => confirm(`Disconnect "${peer.name}"?`) && ctl({ action: 'disconnect' }),
        },
      ]),
    );
    return h(
      'div.device',
      null,
      h(
        'div.device-head',
        null,
        h('span', { class: `dot ${STATE_DOT[link.state] ?? ''}`, title: `WebRTC: ${link.state}` }),
        h('span.name', null, peer.name, h('span.platform', null, peer.info.platform ?? '')),
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
      link.state !== 'connected'
        ? h('div.device-src', null, link.state === 'failed' ? 'Connection failed — reconnect the device' : 'Negotiating media…')
        : null,
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
        h('span.name', null, 'This computer'),
      ),
      ...inputs.map((i) =>
        h(
          'div.device-src',
          null,
          i.kind === 'video' && i.online && i.stream ? thumb(i) : icon(i.kind === 'video' ? (i.type === 'screen' ? 'screen' : 'camera') : 'mic'),
          h('span.lbl', null, i.label),
          i.online ? null : h('span', null, '(offline)'),
          h('span.stat'),
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
    ]);
    if (sig !== signature) {
      signature = sig;
      statEls.clear();
      const children: (Node | string)[] = devices.map(deviceCard);
      if (locals.length) children.push(localCard(locals));
      if (offline.length) {
        const byDevice = new Map<string, Input[]>();
        for (const i of offline) byDevice.set(i.deviceId, [...(byDevice.get(i.deviceId) ?? []), i]);
        for (const inputs of byDevice.values()) {
          children.push(
            h(
              'div.device',
              { style: { opacity: '0.6' } },
              h(
                'div.device-head',
                null,
                h('span.dot'),
                h('span.name', null, inputs[0].deviceName, h('span.platform', null, 'offline')),
                iconBtn('trash', 'Forget device', () => {
                  for (const i of inputs) registry.remove(i.id);
                }),
              ),
              h('div.device-src', null, inputs.map((i) => i.label).join(', ')),
            ),
          );
        }
      }
      if (!devices.length && !locals.length) {
        children.unshift(
          h(
            'div.list-empty',
            null,
            'No devices connected. Click ',
            h('strong', null, 'Connect a device'),
            ' and scan the QR code with your phone.',
          ),
        );
      }
      box.replaceChildren(...children);
      for (const [id, v] of thumbs) if (!v.isConnected) thumbs.delete(id);
    }
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

  toolbar.append(
    h('button.btn.sm.primary', { onclick: () => showConnect(studio) }, icon('qr'), 'Connect a device'),
    h('button.btn.sm', { onclick: () => pickDevice(studio, 'audioinput'), title: 'Add a microphone on this computer' }, icon('mic'), 'Local mic'),
  );

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
            h('small', null, 'Anyone with this link can join while on your network — share it only with your devices'),
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
          onclick: () => {
            if (!confirm('Create a new room code? The current join link stops working and connected devices must rescan.')) return;
            resetStudioRoom();
            close();
            location.reload();
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
  const qrCaption = h('div.qr-caption');
  const buttons: HTMLButtonElement[] = [];
  const showQr = async (url: string, caption: string, selected = -1) => {
    img.src = await QRCode.toDataURL(url, { margin: 1, width: 400, errorCorrectionLevel: 'M' });
    qrCaption.textContent = caption;
    buttons.forEach((b, j) => b.classList.toggle('on', j === selected));
  };
  const select = async (i: number) => {
    const e = entries[i];
    if (e) await showQr(e.url, `QR: ${e.label}`, i);
  };
  const lan = entries.filter((e) => e.kind === 'lan');
  openModal(
    'Connect a device',
    h(
      'div.join-qr',
      null,
      h('div.qr-col', null, img, qrCaption),
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
              h('small', { class: e.kind === 'vpn' ? 'vpn' : '' }, e.label),
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
    h(
      'details.cert-help',
      null,
      h('summary', null, 'Phone says "Not secure" or "Not private"? Install the studio certificate (one time)'),
      h(
        'p',
        null,
        'The studio uses its own local certificate authority. Install it once per phone and the warning goes away. ',
        h(
          'button.btn.sm',
          {
            onclick: () => {
              const base = entries[0]?.url.replace(/\/source$/, '') ?? location.origin;
              void showQr(`${base}/webbroadcaster-ca.crt`, 'QR: studio certificate download');
            },
          },
          'Show certificate QR',
        ),
      ),
      h(
        'p',
        null,
        h('strong', null, 'iPhone / iPad (open in Safari): '),
        'scan, tap ',
        h('em', null, 'Allow'),
        ' → Settings → ',
        h('em', null, 'Profile Downloaded'),
        ' → Install. Then Settings → General → About → ',
        h('em', null, 'Certificate Trust Settings'),
        ' → turn on "WebBroadcaster Local CA".',
      ),
      h(
        'p',
        null,
        h('strong', null, 'Android: '),
        'download it, then Settings → Security → More security settings → Encryption & credentials → ',
        h('em', null, 'Install a certificate → CA certificate'),
        ' and pick the downloaded file.',
      ),
      h(
        'p',
        null,
        h('strong', null, 'This computer: '),
        'run ',
        h('code', null, 'npm run trust'),
        ' in the project folder, then restart the browser.',
      ),
    ),
    entries.length ? '' : h('p', null, 'No network address detected. Make sure this computer is connected to your network.'),
  );
  await select(0);
}
