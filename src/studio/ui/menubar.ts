// Windows-style application menu bar: File / Edit / View … with dropdowns,
// submenus, checkmarks, keyboard shortcuts, Alt-key access and arrow-key
// navigation.

import { h } from '../../lib/util';

export type MenuItem =
  | {
      label: string;
      /** Keyboard binding handled globally, e.g. "Ctrl+Z", "Ctrl+Shift+Z", "F9". */
      keys?: string;
      /** Shortcut shown but handled elsewhere (e.g. "Del", "1–9"). */
      hint?: string;
      checked?: boolean;
      /** Radio-style dot instead of a check. */
      radio?: boolean;
      /** Destructive action (delete, remove…): shown in red. */
      danger?: boolean;
      disabled?: boolean;
      onClick?: () => void;
      submenu?: () => MenuItem[];
    }
  | { sep: true };

export interface Menu {
  label: string;
  /** Access-key letter (underlined when Alt is held). */
  key: string;
  items: () => MenuItem[];
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Every alternative of a binding, for lists: "Ctrl+Y or Ctrl+Shift+Z". */
export function formatKeys(keys: string) {
  return keys
    .split('|')
    .map((k) => keyText(k))
    .join(' or ');
}

function keyText(keys: string) {
  const first = keys.split('|')[0].replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace(/^Delete$/, 'Del');
  return isMac ? first.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : first;
}

/** Does a keydown event match a binding like "Ctrl+Shift+Z"? (Ctrl = ⌘ on Mac; "A|B" = either) */
function matches(e: KeyboardEvent, keys: string): boolean {
  if (keys.includes('|')) return keys.split('|').some((k) => matches(e, k));
  const parts = keys.split('+');
  const key = parts.pop()!.toLowerCase();
  const want = new Set(parts.map((p) => p.toLowerCase()));
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  if (want.has('ctrl') !== ctrl || want.has('shift') !== e.shiftKey || want.has('alt') !== e.altKey) return false;
  const k = e.key.toLowerCase();
  return k === key || (key === 'del' && k === 'delete') || e.code.toLowerCase() === `key${key}`;
}

type SubRef = { el: HTMLElement | null };

/**
 * Render a dropdown list (shared by the menu bar and right-click menus):
 * checkmarks, radio dots, shortcut hints, disabled rows and fly-out submenus.
 */
export function renderMenuList(items: MenuItem[], isSub: boolean, ctx: { close: () => void; sub: SubRef }): HTMLElement {
  const el = h('div', { class: `dropdown${isSub ? ' submenu' : ''}`, role: 'menu' });
  for (const item of items) {
    if ('sep' in item) {
      el.append(h('div.dd-sep', { role: 'separator' }));
      continue;
    }
    const mark = item.checked ? (item.radio ? '●' : '✓') : '';
    const row = h(
      'div.dd-item',
      { role: 'menuitem', 'aria-disabled': item.disabled ? 'true' : 'false', tabindex: '-1' },
      h('span.dd-check', null, mark),
      h('span.dd-label', null, item.label),
      h('span.dd-keys', null, item.submenu ? '›' : item.keys ? keyText(item.keys) : (item.hint ?? '')),
    );
    if (item.disabled) row.classList.add('disabled');
    if (item.danger) row.classList.add('danger');
    if (item.submenu && !item.disabled) {
      row.classList.add('has-sub');
      const showSub = () => {
        ctx.sub.el?.remove();
        const sub = renderMenuList(item.submenu!(), true, ctx);
        ctx.sub.el = sub;
        document.body.append(sub);
        const r = row.getBoundingClientRect();
        const sr = sub.getBoundingClientRect();
        const left = r.right + sr.width > window.innerWidth - 4 ? r.left - sr.width : r.right - 2;
        sub.style.left = `${Math.max(4, left)}px`;
        sub.style.top = `${Math.max(4, Math.min(window.innerHeight - sr.height - 4, r.top - 4))}px`;
      };
      row.addEventListener('pointerenter', showSub);
      row.addEventListener('click', showSub);
    } else {
      if (!isSub) row.addEventListener('pointerenter', () => ctx.sub.el?.remove());
      row.addEventListener('click', () => {
        if (item.disabled) return;
        ctx.close();
        item.onClick?.();
      });
    }
    el.append(row);
  }
  return el;
}

/** Right-click menu at a screen point (same look and behaviour as the menu bar). */
export const contextMenu = (() => {
  let menu: HTMLElement | null = null;
  const sub: SubRef = { el: null };
  let focus = -1;
  const close = () => {
    menu?.remove();
    sub.el?.remove();
    menu = sub.el = null;
    focus = -1;
  };
  const rows = () => (menu ? [...menu.querySelectorAll<HTMLElement>('.dd-item:not([aria-disabled="true"])')] : []);
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Node;
      if (menu && !menu.contains(t) && !sub.el?.contains(t)) close();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!menu) return;
      const list = rows();
      const move = (d: number) => {
        if (!list.length) return;
        focus = (focus + d + list.length) % list.length;
        list.forEach((r, i) => r.classList.toggle('kbd', i === focus));
      };
      const keys: Record<string, () => void> = {
        Escape: close,
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        Enter: () => list[focus]?.click(),
        ArrowRight: () => list[focus]?.click(),
      };
      if (keys[e.key]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        keys[e.key]();
      }
    },
    true,
  );
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  window.addEventListener('wheel', close, { passive: true });

  return {
    open(x: number, y: number, items: MenuItem[]) {
      close();
      if (!items.length) return;
      menu = renderMenuList(items, false, { close, sub });
      menu.classList.add('context-menu');
      document.body.append(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    },
    close,
    get isOpen() {
      return !!menu;
    },
  };
})();

export function mountMenubar(root: HTMLElement, menus: Menu[]) {
  root.replaceChildren();
  const buttons: HTMLButtonElement[] = [];
  let openIndex = -1;
  let dropdown: HTMLElement | null = null;
  let submenuEl: HTMLElement | null = null;
  let focusIndex = -1; // keyboard-highlighted row in the open dropdown

  const labelWithAccess = (label: string, key: string) => {
    const i = label.toLowerCase().indexOf(key.toLowerCase());
    if (i < 0) return [label];
    return [label.slice(0, i), h('u', null, label[i]), label.slice(i + 1)];
  };

  menus.forEach((m, i) => {
    const b = h(
      'button.menubar-item',
      { role: 'menuitem', 'aria-haspopup': 'true', type: 'button' },
      ...labelWithAccess(m.label, m.key),
    ) as HTMLButtonElement;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (openIndex === i) close();
      else open(i);
    });
    // Like Windows: once a menu is open, hovering another title switches to it.
    b.addEventListener('pointerenter', () => {
      if (openIndex >= 0 && openIndex !== i) open(i);
    });
    buttons.push(b);
    root.append(b);
  });

  function rows(): HTMLElement[] {
    return dropdown ? [...dropdown.querySelectorAll<HTMLElement>('.dd-item:not([aria-disabled="true"])')] : [];
  }

  const subRef: SubRef = {
    get el() {
      return submenuEl;
    },
    set el(v) {
      submenuEl = v;
    },
  };
  const renderItems = (items: MenuItem[], isSub: boolean) => renderMenuList(items, isSub, { close: () => close(), sub: subRef });

  function open(i: number) {
    close(false);
    openIndex = i;
    buttons.forEach((b, j) => b.classList.toggle('open', j === i));
    buttons[i].setAttribute('aria-expanded', 'true');
    dropdown = renderItems(menus[i].items(), false);
    document.body.append(dropdown);
    const r = buttons[i].getBoundingClientRect();
    dropdown.style.left = `${r.left}px`;
    dropdown.style.top = `${r.bottom}px`;
    focusIndex = -1;
  }

  function close(clearFocus = true) {
    dropdown?.remove();
    submenuEl?.remove();
    dropdown = submenuEl = null;
    if (openIndex >= 0) buttons[openIndex]?.setAttribute('aria-expanded', 'false');
    openIndex = -1;
    buttons.forEach((b) => b.classList.remove('open'));
    if (clearFocus) root.classList.remove('keyboard');
  }

  function highlight(idx: number) {
    const list = rows();
    if (!list.length) return;
    focusIndex = (idx + list.length) % list.length;
    list.forEach((r, j) => r.classList.toggle('kbd', j === focusIndex));
    list[focusIndex].scrollIntoView({ block: 'nearest' });
  }

  // Close when clicking anywhere else.
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Node;
      if (openIndex < 0) return;
      if (root.contains(t) || dropdown?.contains(t) || submenuEl?.contains(t)) return;
      close();
    },
    true,
  );
  window.addEventListener('blur', () => close());
  window.addEventListener('resize', () => close());

  // ---- keyboard ----
  let altAlone = false;
  // Alt used together with the mouse (Alt+drag to crop, Alt+click, Alt+scroll)
  // is a modifier, not a menu request: don't open the menu bar on release.
  const altUsedWithMouse = (e: PointerEvent | WheelEvent) => {
    if (e.altKey && (e.type !== 'pointermove' || (e as PointerEvent).buttons !== 0)) altAlone = false;
  };
  document.addEventListener('pointerdown', altUsedWithMouse, true);
  document.addEventListener('pointermove', altUsedWithMouse, true);
  document.addEventListener('wheel', altUsedWithMouse, { capture: true, passive: true });
  document.addEventListener(
    'keydown',
    (e) => {
      const typing = e.target instanceof Element && !!e.target.closest('input, textarea, select, [contenteditable]');

      // Navigation inside an open menu.
      if (openIndex >= 0) {
        const nav: Record<string, () => void> = {
          ArrowDown: () => highlight(focusIndex + 1),
          ArrowUp: () => highlight(focusIndex - 1),
          ArrowRight: () => open((openIndex + 1) % menus.length),
          ArrowLeft: () => open((openIndex - 1 + menus.length) % menus.length),
          Escape: () => close(),
          Enter: () => rows()[focusIndex]?.click(),
          ' ': () => rows()[focusIndex]?.click(),
        };
        if (nav[e.key]) {
          e.preventDefault();
          e.stopImmediatePropagation();
          nav[e.key]();
          return;
        }
      }

      // Alt+letter opens that menu; bare Alt (press & release) toggles the bar.
      if (e.key === 'Alt') {
        altAlone = true;
        root.classList.add('alt-held');
        return;
      }
      altAlone = false;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !typing) {
        const i = menus.findIndex((m) => m.key.toLowerCase() === e.key.toLowerCase());
        if (i >= 0) {
          e.preventDefault();
          root.classList.add('keyboard');
          open(i);
          highlight(0);
          return;
        }
      }

      // Global shortcuts declared on menu items.
      if (typing) return;
      const visit = (items: MenuItem[]): boolean => {
        for (const it of items) {
          if ('sep' in it) continue;
          if (it.submenu && visit(it.submenu())) return true;
          if (it.keys && !it.disabled && matches(e, it.keys)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
            it.onClick?.();
            return true;
          }
        }
        return false;
      };
      for (const m of menus) if (visit(m.items())) return;
    },
    true,
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.key !== 'Alt') return;
      root.classList.remove('alt-held');
      if (altAlone) {
        e.preventDefault();
        if (openIndex >= 0) close();
        else {
          root.classList.add('keyboard');
          open(0);
          highlight(0);
        }
      }
      altAlone = false;
    },
    true,
  );

  return { close };
}
