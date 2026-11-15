import { h } from '../../lib/util';
import type { Studio } from '../context';
import { MASTER, MAX_DB, MIN_DB } from '../mixer';
import { iconBtn } from './common';

const pctFromDb = (db: number) => (db <= MIN_DB ? 0 : Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100));

export function mountMixer(studio: Studio, root: HTMLElement) {
  const { mixer } = studio;
  const box = h('div.mixer');
  root.append(box);
  let signature = '';
  const meters = new Map<string, { fill: HTMLElement; hold: HTMLElement; db: HTMLElement }>();
  const expanded = new Set<string>();

  function strip(id: string, name: string, sub: string, online: boolean) {
    const s = mixer.get(id);
    const isMaster = id === MASTER;
    const fill = h('div.fill');
    const hold = h('div.hold');
    const db = h('div.strip-db', null, '-∞');
    meters.set(id, { fill, hold, db });

    const valueLabel = (v: number) => (v <= MIN_DB ? '-∞ dB' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);
    const slider = h('input', {
      type: 'range',
      min: String(MIN_DB),
      max: String(MAX_DB),
      step: '0.5',
      value: String(s.volumeDb),
      title: valueLabel(s.volumeDb),
    }) as HTMLInputElement;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      slider.title = valueLabel(v);
      mixer.set(id, { volumeDb: v });
    });
    slider.addEventListener('dblclick', () => {
      slider.value = '0';
      mixer.set(id, { volumeDb: 0 });
    });

    const controls = h(
      'div.strip-controls',
      null,
      iconBtn(s.muted ? 'micOff' : 'mic', s.muted ? 'Unmute' : 'Mute', () => mixer.set(id, { muted: !mixer.get(id).muted }), s.muted ? 'active-mute' : ''),
      slider,
      iconBtn('headphones', s.monitor ? 'Stop monitoring' : 'Monitor (hear on this computer)', () => mixer.set(id, { monitor: !mixer.get(id).monitor }), s.monitor ? 'active' : ''),
      isMaster
        ? null
        : iconBtn('gear', 'Advanced (sync offset)', () => {
            if (expanded.has(id)) expanded.delete(id);
            else expanded.add(id);
            signature = '';
            render();
          }),
    );
    const extra = expanded.has(id)
      ? h(
          'div.strip-extra',
          null,
          'Sync offset',
          (() => {
            const inp = h('input', { type: 'number', min: '0', max: '2000', step: '10', value: String(s.delayMs) }) as HTMLInputElement;
            inp.addEventListener('input', () => mixer.set(id, { delayMs: Math.max(0, Math.min(2000, Number(inp.value) || 0)) }));
            inp.addEventListener('keydown', (e) => e.stopPropagation());
            return inp;
          })(),
          'ms',
        )
      : null;

    return h(
      'div.strip',
      { class: `strip${online ? '' : ' offline'}${isMaster ? ' master' : ''}`, 'data-input-id': id },
      h('div.strip-name', null, name, sub ? h('small', null, sub) : null),
      db,
      h('div.strip-meter', null, fill, hold),
      controls,
      extra,
    );
  }

  function render() {
    const strips = mixer.strips();
    const sig = JSON.stringify([
      strips.map((s) => [s.id, s.label, s.deviceName, s.online]),
      [...expanded],
      Object.fromEntries([MASTER, ...strips.map((s) => s.id)].map((id) => [id, [mixer.get(id).muted, mixer.get(id).monitor]])),
    ]);
    if (sig === signature) return;
    signature = sig;
    meters.clear();
    box.replaceChildren(
      strip(MASTER, 'Program output', 'master', true),
      ...strips.map((s) => strip(s.id, s.label, s.deviceName + (s.online ? '' : ' · offline'), s.online)),
      strips.length
        ? ''
        : h('div.list-empty', null, 'No audio sources'),
    );
  }

  mixer.on('change', render);
  render();

  (function loop() {
    requestAnimationFrame(loop);
    for (const [id, m] of meters) {
      const { db, hold } = mixer.level(id);
      m.fill.style.clipPath = `inset(0 ${100 - pctFromDb(db)}% 0 0)`;
      m.hold.style.left = `calc(${pctFromDb(hold)}% - 2px)`;
      m.db.textContent = Number.isFinite(db) && db > MIN_DB ? `${db.toFixed(1)}` : '-∞';
    }
  })();
}
