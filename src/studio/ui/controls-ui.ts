import { icon } from '../../lib/icons';
import { formatBytes, formatDuration, h } from '../../lib/util';
import type { Studio } from '../context';
import { Recorder, supportedFormats } from '../recorder';
import type { TransitionType } from '../scenes';
import { errMsg, toast } from './common';

const RESOLUTIONS: [number, number, string][] = [
  [1280, 720, '1280×720 (720p)'],
  [1920, 1080, '1920×1080 (1080p)'],
  [2560, 1440, '2560×1440 (1440p)'],
  [3840, 2160, '3840×2160 (4K)'],
];
const BITRATES: [number, string][] = [
  [4_000_000, '4 Mbps'],
  [8_000_000, '8 Mbps'],
  [12_000_000, '12 Mbps'],
  [20_000_000, '20 Mbps'],
  [40_000_000, '40 Mbps'],
];

export function mountControls(studio: Studio, root: HTMLElement) {
  const { recorder, store, settings, comp, mixer } = studio;
  const box = h('div.controls');
  root.append(box);
  const formats = supportedFormats();
  if (!formats.some((f) => f.id === settings.formatId) && formats[0]) settings.formatId = formats[0].id;

  const recBtn = h('button.rec-btn', { type: 'button' }) as HTMLButtonElement;
  const pauseBtn = h('button.rec-btn', { type: 'button' }) as HTMLButtonElement;
  const recInfo = h('div.rec-info');
  const recErr = h('div.rec-error');
  const recList = h('div.rec-list');
  let captureTrack: MediaStreamTrack | null = null;

  recBtn.addEventListener('click', async () => {
    if (recorder.state !== 'inactive') return recorder.stop();
    const format = formats.find((f) => f.id === settings.formatId);
    if (!format) return toast('This browser cannot record video (MediaRecorder unsupported).');
    mixer.resume();
    const video = comp.canvas.captureStream(settings.fps).getVideoTracks()[0];
    const audio = mixer.output.stream.getAudioTracks()[0];
    const stream = new MediaStream([video, ...(audio ? [audio] : [])]);
    try {
      await recorder.start(stream, { format, videoBitrate: settings.videoBitrate, toDisk: settings.toDisk });
      if (recorder.state === 'inactive') video.stop(); // file picker cancelled
      else captureTrack = video;
    } catch (e) {
      video.stop();
      toast(`Recording failed: ${errMsg(e)}`);
    }
  });
  pauseBtn.addEventListener('click', () => recorder.togglePause());

  const select = <T extends string | number>(
    options: [T, string][],
    value: T,
    onChange: (v: string) => void,
  ) => {
    const s = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    s.append(...options.map(([v, l]) => h('option', { value: String(v) }, l)));
    s.value = String(value);
    return s;
  };

  const transition = select<TransitionType>(
    [
      ['fade', 'Fade'],
      ['cut', 'Cut'],
      ['slide', 'Slide'],
      ['dip', 'Dip to black'],
    ],
    store.transition,
    (v) => {
      store.transition = v as TransitionType;
      store.changed();
    },
  );
  const duration = h('input', { type: 'number', min: '0', max: '5000', step: '50', value: String(store.duration) }) as HTMLInputElement;
  duration.addEventListener('input', () => {
    store.duration = Math.max(0, Math.min(5000, Number(duration.value) || 0));
    store.changed();
  });
  duration.addEventListener('keydown', (e) => e.stopPropagation());

  const res = select(
    RESOLUTIONS.map(([w, hh, l]) => [`${w}x${hh}`, l] as [string, string]),
    `${settings.width}x${settings.height}`,
    (v) => {
      const [w, hh] = v.split('x').map(Number);
      settings.width = w;
      settings.height = hh;
      studio.saveSettings();
    },
  );
  const fps = select<number>([[24, '24 fps'], [25, '25 fps'], [30, '30 fps'], [50, '50 fps'], [60, '60 fps']], settings.fps, (v) => {
    settings.fps = Number(v);
    studio.saveSettings();
  });
  const fmt = select(
    formats.map((f) => [f.id, f.label] as [string, string]),
    settings.formatId,
    (v) => {
      settings.formatId = v;
      studio.saveSettings();
    },
  );
  const br = select<number>(BITRATES, settings.videoBitrate, (v) => {
    settings.videoBitrate = Number(v);
    studio.saveSettings();
  });
  const toDisk = h('input', { type: 'checkbox', checked: settings.toDisk, disabled: !Recorder.canWriteToDisk() }) as HTMLInputElement;
  toDisk.addEventListener('change', () => {
    settings.toDisk = toDisk.checked;
    studio.saveSettings();
  });

  const outputControls = [res, fps, fmt, br, toDisk];

  box.append(
    h('div.rec-row', null, recBtn, pauseBtn, recInfo),
    recErr,
    h('div.ctrl-row', null, 'Transition', transition),
    h('div.ctrl-row', null, 'Duration', h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, duration, 'ms')),
    h('div.prop-group', { style: { padding: '6px 0 0', gap: '6px' } }, h('div.title', null, 'Output')),
    h('div.ctrl-row', null, 'Canvas', res),
    h('div.ctrl-row', null, 'Frame rate', fps),
    h('div.ctrl-row', null, 'Format', fmt),
    h('div.ctrl-row', null, 'Bitrate', br),
    h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: 'var(--muted)' }, title: Recorder.canWriteToDisk() ? '' : 'Requires Chrome/Edge' }, toDisk, 'Write directly to a file on disk'),
    h('div.prop-group', { style: { padding: '6px 0 0', gap: '6px' } }, h('div.title', null, 'Recordings')),
    recList,
  );

  function render() {
    const st = recorder.state;
    const active = st !== 'inactive';
    recBtn.replaceChildren(icon(active ? 'stop' : 'record'));
    recBtn.classList.toggle('recording', st === 'recording');
    recBtn.classList.toggle('active', active);
    recBtn.title = active ? 'Stop recording (F9)' : 'Start recording (F9)';
    recBtn.setAttribute('aria-label', recBtn.title);
    pauseBtn.replaceChildren(icon(st === 'paused' ? 'play' : 'pause'));
    pauseBtn.disabled = !active;
    pauseBtn.title = st === 'paused' ? 'Resume recording (Shift+F9)' : 'Pause recording (Shift+F9)';
    pauseBtn.setAttribute('aria-label', pauseBtn.title);
    pauseBtn.classList.toggle('paused', st === 'paused');
    for (const c of outputControls) c.disabled = active || (c === toDisk && !Recorder.canWriteToDisk());
    recErr.textContent = recorder.error ?? '';
    recList.replaceChildren(
      ...(recorder.recordings.length
        ? recorder.recordings.map((r) =>
            h(
              'div.rec-entry',
              null,
              r.url ? h('a', { href: r.url, download: r.name, title: 'Download' }, r.name) : h('span', { title: 'Saved to disk' }, r.name),
              h('span.meta', null, formatBytes(r.size)),
              h('span.meta', null, `${formatDuration(r.duration)} · ${r.url ? 'click to download' : 'saved to disk'}`),
            ),
          )
        : [h('div.muted', { style: { fontSize: '12px' } }, 'Nothing recorded yet.')]),
    );
    tick();
  }
  function tick() {
    const active = recorder.state !== 'inactive';
    recInfo.classList.toggle('idle', !active);
    recInfo.replaceChildren(
      h('span.rec-time', null, formatDuration(active ? recorder.elapsed : 0)),
      active ? h('span.rec-size', null, formatBytes(recorder.bytes)) : '',
    );
  }
  recorder.on('state', render);
  recorder.on('saved', (r) => {
    captureTrack?.stop();
    captureTrack = null;
    if (r.url) {
      // Auto-download like a desktop recorder would save to disk.
      const a = h('a', { href: r.url, download: r.name });
      a.click();
    }
  });
  setInterval(tick, 500);
  render();

  return {
    /** Same as pressing Start/Stop Recording (keeps the user gesture for the save dialog). */
    toggleRecording: () => recBtn.click(),
  };
}
