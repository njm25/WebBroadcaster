// Visual Studio / Photoshop-style docking for the studio panels, built on
// dockview: drag a panel's tab to dock it left/right/top/bottom of any other
// panel or into it as a tab; right-click a tab to float it, pop it out into
// its own window, or maximize it. The layout is saved automatically.

import { createDockview, themeDark, type DockviewApi, type DockviewTheme } from 'dockview-core';
import { basePath } from '../lib/room';
import { loadJSON, saveJSON } from '../lib/util';

/** Dockable panels and the element (built in studio.astro) each one hosts. */
export const PANELS = {
  program: { title: 'Program', el: 'panel-program' },
  properties: { title: 'Properties', el: 'props' },
  scenes: { title: 'Scenes', el: 'dock-scenes' },
  sources: { title: 'Sources', el: 'dock-sources' },
  mixer: { title: 'Audio Mixer', el: 'dock-mixer' },
  devices: { title: 'Devices', el: 'dock-devices' },
  controls: { title: 'Controls', el: 'dock-controls' },
} as const;
export type PanelId = keyof typeof PANELS;

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_FLOAT = svg('<rect x="2.5" y="4.5" width="9" height="9" rx="1"/><path d="M5.5 4.5v-2h8v8h-2"/>');
const ICON_POPOUT = svg('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>');
const ICON_MAX = svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/>');
const ICON_RESTORE = svg('<rect x="2.5" y="5.5" width="8" height="8" rx="1"/><path d="M5.5 5.5v-3h8v8h-3"/>');

const BOTTOM_ROW: PanelId[] = ['scenes', 'sources', 'mixer', 'devices', 'controls'];
const STORAGE_KEY = 'wb.dock';

/** Dark theme tuned to the studio palette (see .dockview-theme-studio in studio.css). */
const theme: DockviewTheme = {
  ...themeDark,
  name: 'studio',
  className: `${themeDark.className} dockview-theme-studio`,
};

export function mountDocking(root: HTMLElement) {
  // Grab each panel's content once: a closed panel's content is detached from
  // the document, so it must be re-attached from here when reopened.
  const contents = new Map<PanelId, HTMLElement>();
  for (const id of Object.keys(PANELS) as PanelId[]) contents.set(id, document.getElementById(PANELS[id].el)!);
  const content = (id: PanelId) => contents.get(id)!;

  const api: DockviewApi = createDockview(root, {
    theme,
    createComponent: ({ name }) => {
      const host = document.createElement('div');
      host.className = 'dock-panel-host';
      return {
        element: host,
        init: () => host.append(content(name as PanelId)),
      };
    },
    // Right-click a tab: maximize, float, pop out, close.
    getTabContextMenuItems: ({ panel }) => [
      'maximize',
      'float',
      // The program canvas drives recording and the editor, so it stays in this window.
      ...(panel.id === 'program' ? [] : (['popout'] as const)),
      'separator',
      'close',
    ],
    floatingGroupBounds: 'boundedWithinViewport',
    popoutUrl: `${basePath()}popout.html`,
    // Header buttons on every group, like Visual Studio's tool-window caption.
    createRightHeaderActionComponent: (group) => {
      const el = document.createElement('div');
      el.className = 'dock-actions';
      const btn = (title: string, svg: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dock-action';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = svg;
        b.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a tab drag
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
        return b;
      };
      const floatBtn = btn('Float (undock into a window)', ICON_FLOAT, () => api.addFloatingGroup(group));
      const popBtn = btn('Pop out into a new browser window', ICON_POPOUT, () => void api.addPopoutGroup(group));
      const maxBtn = btn('Maximize', ICON_MAX, () => (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize()));
      el.append(floatBtn, popBtn, maxBtn);

      const render = () => {
        const where = group.api.location.type;
        const hasProgram = group.panels.some((p) => p.id === 'program');
        floatBtn.hidden = where !== 'grid';
        popBtn.hidden = where === 'popout' || hasProgram;
        maxBtn.hidden = where !== 'grid';
        const max = group.api.isMaximized();
        maxBtn.innerHTML = max ? ICON_RESTORE : ICON_MAX;
        maxBtn.title = max ? 'Restore' : 'Maximize';
      };
      const subs: { dispose(): void }[] = [];
      return {
        element: el,
        init: () => {
          subs.push(
            group.api.onDidLocationChange(render),
            api.onDidMaximizedGroupChange(render),
            group.api.onDidActivePanelChange(render),
          );
          render();
        },
        dispose: () => subs.forEach((s) => s.dispose()),
      };
    },
  });

  // ---- default arrangement (matches the original fixed layout) ----
  function buildDefault() {
    api.clear();
    api.addPanel({ id: 'program', component: 'program', title: PANELS.program.title });
    api.addPanel({
      id: 'properties',
      component: 'properties',
      title: PANELS.properties.title,
      position: { referencePanel: 'program', direction: 'right' },
      initialWidth: 290,
    });
    api.addPanel({
      id: 'scenes',
      component: 'scenes',
      title: PANELS.scenes.title,
      position: { direction: 'below' },
      initialHeight: 300,
    });
    let prev: PanelId = 'scenes';
    for (const id of BOTTOM_ROW.slice(1)) {
      api.addPanel({
        id,
        component: id,
        title: PANELS[id].title,
        position: { referencePanel: prev, direction: 'right' },
      });
      prev = id;
    }
    // Fixed widths for the side panels; the Audio Mixer takes whatever is left.
    const widths: Partial<Record<PanelId, number>> = { scenes: 200, sources: 260, devices: 320, controls: 230 };
    const used = Object.values(widths).reduce((a, b) => a + (b ?? 0), 0);
    widths.mixer = Math.max(260, root.clientWidth - used);
    for (let pass = 0; pass < 2; pass++) {
      for (const [id, width] of Object.entries(widths)) api.getPanel(id)?.api.setSize({ width });
    }
    api.getPanel('program')?.api.setActive();
  }

  // ---- restore saved layout, else default ----
  const saved = loadJSON<unknown>(STORAGE_KEY, null);
  let restored = false;
  if (saved) {
    try {
      api.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0]);
      // A saved layout must still contain the program view.
      restored = !!api.getPanel('program');
    } catch (e) {
      console.warn('[dock] saved layout invalid, using default', e);
    }
  }
  if (!restored) buildDefault();

  let saveTimer: number | undefined;
  api.onDidLayoutChange(() => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveJSON(STORAGE_KEY, api.toJSON()), 300);
  });

  /** Re-open a closed panel near where it normally lives. */
  function show(id: PanelId) {
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const opts = { id, component: id, title: PANELS[id].title };
    if (id === 'program') {
      api.addPanel({ ...opts, position: { direction: 'left' } });
    } else if (id === 'properties') {
      api.addPanel({
        ...opts,
        position: api.getPanel('program') ? { referencePanel: 'program', direction: 'right' } : { direction: 'right' },
        initialWidth: 290,
      });
    } else {
      // Next to the nearest bottom-row neighbour that's still open.
      const i = BOTTOM_ROW.indexOf(id);
      const left = BOTTOM_ROW.slice(0, i).reverse().find((p) => api.getPanel(p));
      const right = BOTTOM_ROW.slice(i + 1).find((p) => api.getPanel(p));
      if (left) api.addPanel({ ...opts, position: { referencePanel: left, direction: 'right' } });
      else if (right) api.addPanel({ ...opts, position: { referencePanel: right, direction: 'left' } });
      else api.addPanel({ ...opts, position: { direction: 'below' }, initialHeight: 300 });
    }
  }

  return {
    api,
    isOpen: (id: PanelId) => !!api.getPanel(id),
    toggle: (id: PanelId) => {
      const p = api.getPanel(id);
      if (p) api.removePanel(p);
      else show(id);
    },
    show,
    reset: () => buildDefault(),
  };
}

export type DockingController = ReturnType<typeof mountDocking>;
