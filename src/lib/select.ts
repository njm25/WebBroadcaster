// Custom dropdowns that replace the browser's native <select> look, shared by
// the studio and the phone page.
//
// Every <select> on the page is upgraded automatically (including ones created
// later): the native element stays in the DOM, hidden, as the source of truth,
// so existing code keeps working unchanged:
//   select.value = 'x'            → the custom button updates
//   select.addEventListener('change', …)  → fires when the user picks an option
//   select.replaceChildren(...options) / select.disabled = true → reflected
//
// Opt a select out with the attribute data-native.
// Keyboard: Enter/Space/↓ open, ↑↓ Home End move, Enter selects, Esc closes,
// typing jumps to a matching option.

const enhanced = new WeakSet<HTMLSelectElement>();
let openList: { close: () => void } | null = null;

const CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

const proto = HTMLSelectElement.prototype;
const valueDesc = Object.getOwnPropertyDescriptor(proto, 'value')!;
const indexDesc = Object.getOwnPropertyDescriptor(proto, 'selectedIndex')!;

let seq = 0;

export function enhanceSelect(select: HTMLSelectElement) {
  if (enhanced.has(select) || select.multiple || select.size > 1 || select.hasAttribute('data-native')) return;
  enhanced.add(select);

  const id = `cs-${++seq}`;
  const wrap = document.createElement('div');
  wrap.className = 'cs';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${id}-list`);
  const label = document.createElement('span');
  label.className = 'cs-label';
  const chevron = document.createElement('span');
  chevron.className = 'cs-chevron';
  chevron.innerHTML = CHEVRON;
  trigger.append(label, chevron);

  // Carry over accessible name / tooltip from the native element.
  const aria = select.getAttribute('aria-label') ?? select.title;
  if (aria) trigger.setAttribute('aria-label', aria);
  if (select.title) trigger.title = select.title;
  if (select.id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(select.id)}"]`);
    lbl?.addEventListener('click', (e) => {
      e.preventDefault();
      trigger.focus();
    });
  }

  select.parentNode?.insertBefore(wrap, select);
  wrap.append(select, trigger);
  select.classList.add('cs-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const sync = () => {
    const opt = select.options[select.selectedIndex];
    label.textContent = opt?.textContent ?? '';
    trigger.disabled = select.disabled;
    wrap.classList.toggle('disabled', select.disabled);
  };

  // Keep the button in sync with programmatic changes.
  Object.defineProperty(select, 'value', {
    configurable: true,
    get: () => valueDesc.get!.call(select),
    set: (v: string) => {
      valueDesc.set!.call(select, v);
      sync();
    },
  });
  Object.defineProperty(select, 'selectedIndex', {
    configurable: true,
    get: () => indexDesc.get!.call(select),
    set: (v: number) => {
      indexDesc.set!.call(select, v);
      sync();
    },
  });
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
  select.addEventListener('change', sync);
  sync();

  const choose = (index: number) => {
    if (index < 0 || index === select.selectedIndex) return;
    indexDesc.set!.call(select, index);
    sync();
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ---------------------------------------------------------------- the list
  const open = () => {
    if (select.disabled) return;
    openList?.close();
    const list = document.createElement('div');
    list.className = 'cs-list';
    list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    const rows: HTMLElement[] = [];
    let active = select.selectedIndex;

    [...select.options].forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = 'cs-option';
      row.id = `${id}-opt-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === select.selectedIndex));
      if (opt.disabled) row.setAttribute('aria-disabled', 'true');
      const check = document.createElement('span');
      check.className = 'cs-check';
      check.textContent = i === select.selectedIndex ? '✓' : '';
      const text = document.createElement('span');
      text.textContent = opt.textContent ?? '';
      // Optional per-option font preview: <option data-font="Georgia, serif">
      if (opt.dataset.font) text.style.fontFamily = opt.dataset.font;
      row.append(check, text);
      row.addEventListener('pointerenter', () => highlight(i, false));
      row.addEventListener('click', () => {
        if (opt.disabled) return;
        close();
        choose(i);
        trigger.focus();
      });
      rows.push(row);
      list.append(row);
    });

    const highlight = (i: number, scroll = true) => {
      if (i < 0 || i >= rows.length) return;
      active = i;
      rows.forEach((r, j) => r.classList.toggle('active', j === i));
      trigger.setAttribute('aria-activedescendant', rows[i].id);
      if (scroll) rows[i].scrollIntoView({ block: 'nearest' });
    };
    const step = (from: number, dir: number) => {
      for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (!select.options[i].disabled) return i;
      return from;
    };

    // Position under (or above) the button, at least as wide as it.
    document.body.append(list);
    const r = trigger.getBoundingClientRect();
    list.style.minWidth = `${r.width}px`;
    const lr = list.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const placeAbove = lr.height > below && above > below;
    list.style.maxHeight = `${Math.max(120, Math.min(320, placeAbove ? above : below))}px`;
    const h = list.getBoundingClientRect().height;
    list.style.top = `${placeAbove ? r.top - h - 4 : r.bottom + 4}px`;
    list.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - list.getBoundingClientRect().width - 4))}px`;
    list.classList.toggle('above', placeAbove);
    highlight(Math.max(0, active));

    trigger.setAttribute('aria-expanded', 'true');
    wrap.classList.add('open');

    let typed = '';
    let typedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        ArrowDown: () => highlight(step(active, 1)),
        ArrowUp: () => highlight(step(active, -1)),
        Home: () => highlight(step(-1, 1)),
        End: () => highlight(step(rows.length, -1)),
        PageDown: () => highlight(Math.min(rows.length - 1, active + 8)),
        PageUp: () => highlight(Math.max(0, active - 8)),
        Enter: () => {
          close();
          choose(active);
        },
        ' ': () => {
          close();
          choose(active);
        },
        Escape: () => close(),
        Tab: () => close(),
      };
      if (keys[e.key]) {
        if (e.key !== 'Tab') e.preventDefault();
        e.stopImmediatePropagation();
        keys[e.key]();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Type-ahead
        const now = performance.now();
        typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
        typedAt = now;
        const i = [...select.options].findIndex((o) => !o.disabled && (o.textContent ?? '').toLowerCase().startsWith(typed));
        if (i >= 0) highlight(i);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.contains(t) && !trigger.contains(t)) close();
    };
    const onScroll = (e: Event) => {
      if (!list.contains(e.target as Node)) close();
    };

    function close() {
      list.remove();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      wrap.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      if (openList?.close === close) openList = null;
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    openList = { close };
  };

  trigger.addEventListener('click', () => (wrap.classList.contains('open') ? openList?.close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (wrap.classList.contains('open')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
}

/** Upgrade every <select> under `root` now and whenever new ones appear. */
export function autoEnhanceSelects(root: ParentNode = document.body) {
  root.querySelectorAll('select').forEach(enhanceSelect);
  new MutationObserver((records) => {
    for (const rec of records) {
      rec.addedNodes.forEach((n) => {
        if (n instanceof HTMLSelectElement) enhanceSelect(n);
        else if (n instanceof Element) n.querySelectorAll('select').forEach(enhanceSelect);
      });
    }
  }).observe(root, { childList: true, subtree: true });
}
