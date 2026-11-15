import { icon } from '../../lib/icons';
import { assets, clamp, h, uid } from '../../lib/util';
import type { Studio } from '../context';
import { DEFAULT_KEY, SCENE_H, SCENE_W, fitBox, keyOf, type Fit, type KeyMode, type KeySettings, type SceneItem, type TextStyle } from '../scenes';
import {
  fontStack,
  loadSystemFonts,
  loadedSystemFonts,
  preloadSystemFontsIfAllowed,
  primaryFamily,
  systemFontsSupported,
} from '../../lib/system-fonts';
import { segmented, toast } from './common';
import { itemIcon } from './scenes-dock';

type FieldEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
interface Field {
  el: FieldEl | HTMLElement;
  read: (it: SceneItem) => string | number | boolean;
  /** Custom controls (e.g. segmented) update themselves through this. */
  apply?: (v: string | number | boolean) => void;
}

const FONTS = [
  ['system-ui, sans-serif', 'System UI'],
  ['Inter, Helvetica, Arial, sans-serif', 'Sans (Helvetica)'],
  ['Georgia, serif', 'Serif (Georgia)'],
  ['ui-monospace, Consolas, monospace', 'Monospace'],
  ['Impact, sans-serif', 'Impact'],
];
const LOAD_SYSTEM_FONTS = '__load_system_fonts__';

/**
 * Font dropdown options: built-in stacks, then this computer's installed fonts
 * (once loaded), plus the current font if it isn't in either list. Each option
 * previews in its own typeface.
 */
function fontOptions(current: string): HTMLOptionElement[] {
  const opt = (value: string, label: string, preview = value) =>
    h('option', { value, 'data-font': preview }, label) as HTMLOptionElement;
  const out = FONTS.map(([v, l]) => opt(v, l));
  const known = new Set(FONTS.map(([v]) => v));
  const installed = loadedSystemFonts();
  if (installed?.length) {
    out.push(h('option', { disabled: true, value: '' }, 'Installed fonts') as HTMLOptionElement);
    for (const family of installed) {
      const stack = fontStack(family);
      known.add(stack);
      out.push(opt(stack, family));
    }
  } else if (systemFontsSupported()) {
    out.push(h('option', { value: LOAD_SYSTEM_FONTS }, 'Show all installed fonts…') as HTMLOptionElement);
  }
  if (current && !known.has(current)) {
    const fam = primaryFamily(current);
    out.splice(FONTS.length, 0, opt(current, installed ? `${fam} (not installed)` : fam));
  }
  return out;
}

export function mountProps(studio: Studio, root: HTMLElement) {
  const { store, registry, comp } = studio;
  let builtFor: string | null | undefined;
  let fields: Field[] = [];

  const update = (patch: Partial<SceneItem>) => {
    const it = store.selectedItem;
    if (it) store.updateItem(it.id, patch);
  };
  const updateSource = (patch: Record<string, unknown>) => {
    const it = store.selectedItem;
    if (it) store.updateItem(it.id, { source: { ...it.source, ...patch } as SceneItem['source'] });
  };

  function bind<T extends FieldEl>(el: T, read: Field['read'], write: (v: string, el: T) => void, event = 'input') {
    fields.push({ el, read });
    el.addEventListener(event, () => write(el instanceof HTMLInputElement && el.type === 'checkbox' ? String(el.checked) : el.value, el));
    el.addEventListener('keydown', (e) => e.stopPropagation());
    return el;
  }

  /** Bare number input bound to an item property. */
  const numField = (read: (it: SceneItem) => number, write: (v: number) => void, step = 1, min?: number, max?: number) =>
    bind(
      h('input', { type: 'number', step: String(step), min: min !== undefined ? String(min) : undefined, max: max !== undefined ? String(max) : undefined }) as HTMLInputElement,
      read,
      (v) => {
        const n = Number(v);
        if (v.trim() !== '' && Number.isFinite(n)) write(n);
      },
    );

  // ---------------------------------------------------------------- keying
  /** Update the selected item's key settings. */
  const setKey = (patch: Partial<KeySettings>) => {
    const cur = store.selectedItem;
    if (cur) store.updateItem(cur.id, { key: { ...keyOf(cur), ...patch } });
  };

  /** Slider row bound to a key setting, with its value shown at the right. */
  const keySlider = (
    label: string,
    field: keyof KeySettings,
    min: number,
    max: number,
    tip: string,
    fmt: (v: number) => string = (v) => String(v),
    patchFor: (v: number) => Partial<KeySettings> = (v) => ({ [field]: v }) as Partial<KeySettings>,
  ) => {
    const input = bind(
      h('input', { type: 'range', min: String(min), max: String(max), step: '1' }) as HTMLInputElement,
      (i) => keyOf(i)[field] as number,
      (v) => setKey(patchFor(Number(v))),
    );
    const out = h('span.slider-val');
    fields.push({ el: out, read: (i) => keyOf(i)[field] as number, apply: (v) => (out.textContent = fmt(Number(v))) });
    return h('div.prop-row', { title: tip }, h('span', null, label), h('div.slider-row', null, input, out));
  };

  /** "Keying" section for video sources: color key or AI background removal. */
  function keyingGroup(it: SceneItem): HTMLElement {
    const k = keyOf(it);
    const modeCtl = segmented<KeyMode>(
      [
        { value: 'none', label: 'No keying', text: 'None' },
        { value: 'color', label: 'Remove a color (green/blue screen)', text: 'Color key' },
        { value: 'remove', label: 'Remove the background with AI (no green screen needed)', text: 'Remove BG' },
      ],
      k.mode,
      (v) => {
        setKey({ mode: v });
        build(); // show that mode's settings
      },
      'Keying mode',
    );
    fields.push({ el: modeCtl.el, read: (i) => keyOf(i).mode, apply: (v) => modeCtl.set(v as KeyMode) });

    const rows: HTMLElement[] = [h('div.prop-row', null, h('span', null, 'Mode'), modeCtl.el)];
    const pct = (v: number) => `${v}%`;

    if (!comp.effects.supported) {
      rows.push(h('p.key-note', null, 'Keying needs WebGL2, which this browser does not have.'));
    } else if (k.mode === 'color') {
      const color = bind(h('input', { type: 'color' }) as HTMLInputElement, (i) => keyOf(i).color, (v) => setKey({ color: v }));
      const preset = (label: string, hex: string) =>
        h('button.btn.sm', { type: 'button', onclick: () => setKey({ color: hex }), title: `Key out ${label.toLowerCase()}` }, label);
      rows.push(
        h(
          'div.prop-row',
          { title: 'The color to make transparent' },
          h('span', null, 'Key color'),
          h('div.key-color', null, color, preset('Green', '#00ff00'), preset('Blue', '#0000ff')),
        ),
        keySlider('Similarity', 'similarity', 1, 100, 'How close a color must be to the key color to be removed. Raise it until the screen disappears.', pct),
        keySlider('Smoothness', 'smoothness', 1, 100, 'Softens the edge between removed and kept areas.', pct),
        keySlider('Spill', 'spill', 1, 100, 'Removes the key-colored tint that reflects onto people and objects.', pct),
      );
    } else if (k.mode === 'remove') {
      const qualityCtl = segmented<KeySettings['quality']>(
        [
          { value: 'fast', label: 'Fast: lighter on the computer', text: 'Fast' },
          { value: 'accurate', label: 'Accurate: better hair and edges, uses more power', text: 'Accurate' },
        ],
        k.quality,
        (v) => setKey({ quality: v }),
        'Background removal quality',
      );
      fields.push({ el: qualityCtl.el, read: (i) => keyOf(i).quality, apply: (v) => qualityCtl.set(v as KeySettings['quality']) });
      rows.push(
        h('div.prop-row', null, h('span', null, 'Quality'), qualityCtl.el),
        keySlider('Threshold', 'threshold', 1, 99, 'How sure the model must be that a pixel belongs to a person. Raise it to remove more background.', pct),
        keySlider('Softness', 'softness', 0, 100, 'How hard or gradual the edge of the cut-out is.', pct),
        keySlider('Feather', 'feather', 0, 100, 'Widens the soft edge around the cut-out so it fades into what is behind.', pct),
        keySlider('Edge shift', 'shift', -50, 50, 'Shrinks (−) or grows (+) the cut-out around the person.', (v) => (v > 0 ? `+${v}` : String(v))),
        keySlider('Smoothing', 'smoothing', 0, 95, 'Steadies the cut-out between frames. Higher = less flicker but slower to follow fast motion.', pct),
        keySlider('BG opacity', 'bgOpacity', 0, 100, 'How much of the original background stays visible. 0% removes it completely.', pct),
        keySlider('BG blur', 'bgBlur', 0, 100, 'Blurs everything behind you: other sources underneath, and the camera’s own background when BG opacity is above 0%.', pct),
      );
      const status = comp.effects.status(k.quality);
      if (status) rows.push(h('p.key-note', null, status));
    }

    if (k.mode !== 'none') {
      rows.push(
        h(
          'div.prop-actions',
          null,
          h('button.btn.sm', { type: 'button', onclick: () => setKey({ ...DEFAULT_KEY, mode: k.mode }) }, 'Reset keying'),
        ),
      );
    }
    return h('div.prop-group', null, h('div.title', null, 'Keying'), ...rows);
  }

  /** Compact labelled number input for the two-column grids (X/Y/W/H, crop). */
  const num = (label: string, read: (it: SceneItem) => number, write: (v: number) => void, step = 1) =>
    h('label', null, label, numField(read, write, step));

  function build() {
    fields = [];
    const it = store.selectedItem;
    builtFor = it?.id ?? null;
    if (!it) {
      root.replaceChildren(
        h('h3', null, 'Properties'),
        h(
          'p.empty',
          null,
          'No source selected.',
        ),
      );
      return;
    }

    const groups: HTMLElement[] = [];
    const nameInput = bind(h('input', { type: 'text' }) as HTMLInputElement, (i) => i.name, (v) => update({ name: v || 'Item' }));
    groups.push(h('h3', null, icon(itemIcon(studio, it)), nameInput));

    // ---- source
    const src = it.source;
    if (src.type === 'input') {
      const input = registry.get(src.inputId);
      const sel = bind(
        h('select') as HTMLSelectElement,
        (i) => (i.source.type === 'input' ? i.source.inputId : ''),
        (v) => update({ source: { type: 'input', inputId: v } }),
        'change',
      );
      sel.append(
        ...registry
          .list('video')
          .map((v) => h('option', { value: v.id }, `${v.deviceName} · ${v.label}${v.online ? '' : ' (offline)'}`)),
      );
      if (!input) sel.append(h('option', { value: src.inputId }, 'Unknown source'));
      const size = comp.naturalSize(it);
      groups.push(
        h(
          'div.prop-group',
          null,
          h('div.title', null, 'Source'),
          sel,
          h(
            'div.prop-row',
            null,
            h('span', null, 'Status'),
            h(
              'div',
              null,
              h('span', { class: `dot ${input?.online ? 'ok' : 'bad'}` }),
              ' ',
              input?.online ? `Live${size ? ` · ${size.w}×${size.h}` : ''}` : 'Offline',
            ),
          ),
        ),
        keyingGroup(it),
      );
    } else if (src.type === 'text') {
      const ta = bind(h('textarea', { rows: 3 }) as HTMLTextAreaElement, (i) => (i.source as TextStyle).text, (v) => updateSource({ text: v }));
      const font = bind(
        h('select') as HTMLSelectElement,
        (i) => (i.source as TextStyle).font,
        (v) => {
          if (v !== LOAD_SYSTEM_FONTS) return updateSource({ font: v });
          // "Show all installed fonts…": ask once, then rebuild with the full list.
          font.value = (store.selectedItem?.source as TextStyle | undefined)?.font ?? FONTS[0][0];
          loadSystemFonts()
            .then(() => build())
            .catch((e) => toast(`Couldn't read installed fonts: ${(e as Error).message || e}`));
        },
        'change',
      );
      font.append(...fontOptions(src.font));
      const alignCtl = segmented<TextStyle['align']>(
        [
          { value: 'left', label: 'Align left', icon: 'alignLeft' },
          { value: 'center', label: 'Align center', icon: 'alignCenter' },
          { value: 'right', label: 'Align right', icon: 'alignRight' },
        ],
        src.align,
        (v) => updateSource({ align: v }),
        'Text alignment',
      );
      fields.push({
        el: alignCtl.el,
        read: (i) => (i.source as TextStyle).align,
        apply: (v) => alignCtl.set(v as TextStyle['align']),
      });
      const align = alignCtl.el;
      const color = bind(h('input', { type: 'color' }) as HTMLInputElement, (i) => (i.source as TextStyle).color, (v) => updateSource({ color: v }));
      const bgOn = bind(
        h('input', { type: 'checkbox' }) as HTMLInputElement,
        (i) => !!(i.source as TextStyle).bg,
        (v) => updateSource({ bg: v === 'true' ? '#000000b3' : '' }),
        'change',
      );
      const bg = bind(
        h('input', { type: 'color' }) as HTMLInputElement,
        (i) => ((i.source as TextStyle).bg || '#000000').slice(0, 7),
        (v) => updateSource({ bg: `${v}b3` }),
      );
      const bold = bind(h('input', { type: 'checkbox' }) as HTMLInputElement, (i) => (i.source as TextStyle).bold, (v) => updateSource({ bold: v === 'true' }), 'change');
      groups.push(
        h(
          'div.prop-group',
          null,
          h('div.title', null, 'Text'),
          ta,
          h('div.prop-row', null, h('span', null, 'Font'), font),
          h('div.prop-row', null, h('span', null, 'Align'), align),
          h(
            'div.prop-row',
            { title: 'Font size in pixels (6–600)' },
            h('span', null, 'Size'),
            numField((i) => (i.source as TextStyle).size ?? 72, (v) => updateSource({ size: clamp(Math.round(v), 6, 600) }), 1, 6, 600),
          ),
          h(
            'div.prop-row',
            { title: 'Black outline around the letters, in pixels (0 = none)' },
            h('span', null, 'Outline'),
            numField((i) => (i.source as TextStyle).outline ?? 0, (v) => updateSource({ outline: clamp(Math.round(v), 0, 30) }), 1, 0, 30),
          ),
          h('div.prop-row', null, h('span', null, 'Color'), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, color, h('label', null, bold, ' Bold'))),
          h('div.prop-row', null, h('span', null, 'Background'), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, bgOn, bg)),
          h(
            'div.prop-actions',
            null,
            h('button.btn.sm', { onclick: () => fitToNatural() }, 'Size to text'),
          ),
        ),
      );
    } else if (src.type === 'color') {
      const color = bind(
        h('input', { type: 'color' }) as HTMLInputElement,
        (i) => (i.source.type === 'color' ? i.source.color : '#000000'),
        (v) => updateSource({ color: v }),
      );
      groups.push(h('div.prop-group', null, h('div.title', null, 'Color'), h('div.prop-row', null, h('span', null, 'Fill'), color)));
    } else if (src.type === 'image') {
      groups.push(
        h(
          'div.prop-group',
          null,
          h('div.title', null, 'Image'),
          h('div.prop-row', null, h('span', null, 'File'), h('span', null, src.name)),
          h('div.prop-actions', null, h('button.btn.sm', { onclick: () => replaceImage() }, 'Replace…'), h('button.btn.sm', { onclick: () => fitToNatural() }, 'Original size')),
        ),
      );
    }

    // ---- transform
    const fit = bind(h('select') as HTMLSelectElement, (i) => i.fit, (v) => update({ fit: v as Fit }), 'change');
    fit.append(h('option', { value: 'contain' }, 'Fit (letterbox)'), h('option', { value: 'cover' }, 'Fill (crop to box)'), h('option', { value: 'stretch' }, 'Stretch'));
    const flip = bind(h('input', { type: 'checkbox' }) as HTMLInputElement, (i) => i.flipH, (v) => update({ flipH: v === 'true' }), 'change');
    const opacity = bind(
      h('input', { type: 'range', min: '0', max: '100' }) as HTMLInputElement,
      (i) => Math.round(i.opacity * 100),
      (v) => update({ opacity: Number(v) / 100 }),
    );
    const pct = (v: number) => Math.round(v * 1000) / 10;
    const cropField = (label: string, k: 'l' | 't' | 'r' | 'b') =>
      num(label, (i) => pct(i.crop[k]), (v) => {
        const i = store.selectedItem;
        if (!i) return;
        const c = { ...i.crop, [k]: clamp(v / 100, 0, 0.98) };
        if (c.l + c.r > 0.98 || c.t + c.b > 0.98) return;
        update({ crop: c });
      }, 0.5);

    groups.push(
      h(
        'div.prop-group',
        null,
        h('div.title', null, 'Transform'),
        h(
          'div.prop-grid',
          null,
          num('X', (i) => Math.round(i.x), (v) => update({ x: Math.round(v) })),
          num('Y', (i) => Math.round(i.y), (v) => update({ y: Math.round(v) })),
          num('W', (i) => Math.round(i.w), (v) => update({ w: Math.max(1, Math.round(v)) })),
          num('H', (i) => Math.round(i.h), (v) => update({ h: Math.max(1, Math.round(v)) })),
        ),
        h(
          'div.prop-actions',
          null,
          h('button.btn.sm', { onclick: () => fitScreen('contain') }, icon('fit'), 'Fit screen'),
          h('button.btn.sm', { onclick: () => fitScreen('stretch') }, 'Fill screen'),
          h('button.btn.sm', { onclick: () => center() }, 'Center'),
          h('button.btn.sm', { onclick: () => matchAspect() }, 'Match source aspect'),
        ),
        h('div.prop-row', null, h('span', null, 'Scaling'), fit),
        h('div.prop-row', null, h('span', null, 'Opacity'), opacity),
        h(
          'div.prop-row',
          { title: 'Rounded corners, in pixels (0 = square)' },
          h('span', null, 'Corners'),
          numField((i) => i.radius ?? 0, (v) => update({ radius: clamp(Math.round(v), 0, 540) }), 1, 0, 540),
        ),
        h('div.prop-row', { title: 'Flip the image left-to-right' }, h('span', null, 'Mirror'), h('div.prop-switch', null, flip)),
      ),
      h(
        'div.prop-group',
        null,
        h('div.title', null, 'Crop (%)'),
        h('div.prop-grid', null, cropField('L', 'l'), cropField('R', 'r'), cropField('T', 't'), cropField('B', 'b')),
        h('div.prop-actions', null, h('button.btn.sm', { onclick: () => update({ crop: { l: 0, t: 0, r: 0, b: 0 } }) }, 'Reset crop')),
      ),
      h(
        'div.prop-group',
        null,
        h(
          'div.prop-actions',
          null,
          h('button.btn.sm', { onclick: () => store.moveItem(it.id, 99) }, 'Bring to front'),
          h('button.btn.sm', { onclick: () => store.moveItem(it.id, -99) }, 'Send to back'),
          h('button.btn.sm.danger', { onclick: () => store.removeItem(it.id) }, 'Remove'),
        ),
      ),
    );
    root.replaceChildren(...groups);
    refresh();
  }

  function refresh() {
    const it = store.selectedItem;
    if ((it?.id ?? null) !== builtFor) return build();
    if (!it) return;
    for (const f of fields) {
      if (document.activeElement === f.el) continue;
      const v = f.read(it);
      if (f.apply) f.apply(v);
      else if (f.el instanceof HTMLInputElement && f.el.type === 'checkbox') f.el.checked = !!v;
      else if ('value' in f.el && f.el.value !== String(v)) f.el.value = String(v);
    }
  }

  // ---- actions
  const sourceSize = (it: SceneItem) => {
    const n = comp.naturalSize(it);
    if (!n) return null;
    const c = it.crop;
    return { w: n.w * (1 - c.l - c.r), h: n.h * (1 - c.t - c.b) };
  };
  function fitScreen(mode: 'contain' | 'stretch') {
    const it = store.selectedItem;
    if (!it) return;
    if (mode === 'stretch') return update({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fit: 'stretch' });
    const s = sourceSize(it);
    update(s ? { ...fitBox(s.w, s.h), fit: 'contain' } : { x: 0, y: 0, w: SCENE_W, h: SCENE_H, fit: 'contain' });
  }
  function center() {
    const it = store.selectedItem;
    if (it) update({ x: Math.round((SCENE_W - it.w) / 2), y: Math.round((SCENE_H - it.h) / 2) });
  }
  function matchAspect() {
    const it = store.selectedItem;
    const s = it && sourceSize(it);
    if (it && s) update({ h: Math.round((it.w * s.h) / s.w) });
  }
  function fitToNatural() {
    const it = store.selectedItem;
    const s = it && sourceSize(it);
    if (it && s) update({ w: Math.round(s.w), h: Math.round(s.h) });
  }
  function replaceImage() {
    const file = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      const assetId = uid('a');
      await assets.put(assetId, f);
      update({ source: { type: 'image', assetId, name: f.name } });
    };
    file.click();
  }

  store.on('select', build);
  store.on('change', refresh);
  registry.on('change', () => {
    if (!root.contains(document.activeElement)) build();
  });
  // Background-removal model finished loading (or failed): update the note.
  comp.effects.onStatus(() => {
    if (!root.contains(document.activeElement)) build();
  });
  build();

  // Installed fonts were allowed before? Load them quietly so the list is ready.
  void preloadSystemFontsIfAllowed().then((list) => {
    if (list?.length && store.selectedItem?.source.type === 'text') build();
  });
}
