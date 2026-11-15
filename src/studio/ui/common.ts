import { icon } from '../../lib/icons';
import { h } from '../../lib/util';

export type MenuEntry =
  | { label: string; icon?: string; sub?: string; disabled?: boolean; onClick: () => void }
  | { sep: true }
  | { heading: string };

let openMenuEl: HTMLElement | null = null;

export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

/** Pop-up menu anchored to an element. */
export function openMenu(anchor: HTMLElement, entries: MenuEntry[]) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu' });
  for (const e of entries) {
    if ('sep' in e) menu.append(h('div.menu-sep'));
    else if ('heading' in e) menu.append(h('div.menu-label', null, e.heading));
    else {
      menu.append(
        h(
          'button.menu-item',
          {
            disabled: e.disabled,
            onclick: () => {
              closeMenu();
              e.onClick();
            },
          },
          e.icon ? icon(e.icon) : null,
          h('span', null, e.label),
          e.sub ? h('span.sub', null, e.sub) : null,
        ),
      );
    }
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  let top = r.top - mr.height - 4;
  if (top < 8) top = Math.min(window.innerHeight - mr.height - 8, r.bottom + 4);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.min(window.innerWidth - mr.width - 8, Math.max(8, r.left))}px`;
  openMenuEl = menu;
  setTimeout(() => {
    const off = (ev: Event) => {
      if (!menu.contains(ev.target as Node)) {
        closeMenu();
        document.removeEventListener('pointerdown', off, true);
      }
    };
    document.addEventListener('pointerdown', off, true);
  });
}

/** Modal dialog. Returns a close function. */
export function openModal(title: string, ...content: (Node | string)[]) {
  const root = document.getElementById('modal-root')!;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const backdrop = h(
    'div.modal-backdrop',
    { onclick: (e: Event) => e.target === backdrop && close() },
    h(
      'div.modal',
      { role: 'dialog' },
      h('h2', null, title, h('button.btn.ghost.icon', { onclick: close, 'aria-label': 'Close' }, icon('x'))),
      ...content,
    ),
  );
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return close;
}

export function iconBtn(name: string, title: string, onClick: (e: MouseEvent) => void, cls = '') {
  return h(
    'button.item-btn',
    {
      title,
      'aria-label': title,
      class: `item-btn ${cls}`,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        onClick(e);
      },
    },
    icon(name),
  );
}

export function toolBtn(name: string, title: string, onClick: (e: MouseEvent) => void, disabled = false) {
  return h('button.btn.ghost', { title, 'aria-label': title, disabled, onclick: onClick }, icon(name));
}

/** Inline rename: replaces `nameEl` with an input until Enter/blur. */
export function inlineRename(nameEl: HTMLElement, value: string, commit: (v: string) => void) {
  const input = h('input.rename', { type: 'text', value }) as HTMLInputElement;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value.trim()) commit(input.value.trim());
    else input.replaceWith(nameEl);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

export function toast(msg: string, ms = 3500) {
  const t = h(
    'div',
    {
      style: {
        position: 'fixed',
        left: '50%',
        bottom: '320px',
        transform: 'translateX(-50%)',
        background: '#2a2f3a',
        border: '1px solid #3a4150',
        padding: '8px 14px',
        borderRadius: '8px',
        zIndex: '200',
        boxShadow: '0 8px 24px #0008',
        maxWidth: '80vw',
      },
    },
    msg,
  );
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SegmentOption<T extends string> {
  value: T;
  label: string; // tooltip + accessible name
  icon?: string;
  text?: string; // visible text when there's no icon
}

/**
 * Segmented control: a row of icon (or text) buttons where exactly one is
 * active, e.g. text alignment. Arrow keys move between options.
 * Returns the element and a `set` to update it without firing onChange.
 */
export function segmented<T extends string>(options: SegmentOption<T>[], value: T, onChange: (v: T) => void, label = 'Options') {
  const el = h('div.segmented', { role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) => {
    const b = h(
      'button.seg-btn',
      { type: 'button', role: 'radio', title: o.label, 'aria-label': o.label },
      o.icon ? icon(o.icon) : (o.text ?? o.label),
    ) as HTMLButtonElement;
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    el.append(b);
    return b;
  });
  const set = (v: T) => {
    options.forEach((o, i) => {
      const on = o.value === v;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-checked', String(on));
      buttons[i].tabIndex = on ? 0 : -1;
    });
  };
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const j = (i + d + buttons.length) % buttons.length;
    buttons[j].focus();
    buttons[j].click();
  });
  set(value);
  return { el, set };
}
