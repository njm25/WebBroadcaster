// Custom tooltips that replace the browser's native `title` tooltips, shared
// by the studio and the phone page.
//
// Any element with a `title` (now or later, including titles changed at
// runtime) gets the styled tooltip instead: the title text moves to
// data-tip so the native one never appears, and becomes the aria-label when
// the element has no other accessible name.
//
// Shows after a short hover delay (instantly when moving between tooltipped
// elements), on keyboard focus, flips above/below to stay on screen, and hides
// on click, scroll, Esc or leaving. Opt out with data-native-title.

const SHOW_DELAY = 450;
const SKIP_DELAY_WINDOW = 400; // after a tooltip hides, the next one shows instantly

let tipEl: HTMLDivElement | null = null;
let current: Element | null = null;
let showTimer: number | undefined;
let lastHide = 0;

/** Move a native title into data-tip (and aria-label if needed). Returns the text. */
function adoptTitle(el: Element): string {
  const title = el.getAttribute('title');
  if (title !== null) {
    el.removeAttribute('title');
    if (title.trim()) {
      el.setAttribute('data-tip', title);
      const hasName = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || (el.textContent ?? '').trim().length > 0;
      if (!hasName) el.setAttribute('aria-label', title);
    } else {
      el.removeAttribute('data-tip');
    }
  }
  return el.getAttribute('data-tip') ?? '';
}

function findTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest('[title], [data-tip]');
  if (!el || el.hasAttribute('data-native-title') || el.closest('svg') === el) return null;
  return el;
}

function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.id = 'app-tooltip';
  }
  return tipEl;
}

function place(el: Element) {
  const tip = ensureTip();
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8;
  let top = r.top - t.height - gap;
  let below = false;
  if (top < 4) {
    top = r.bottom + gap;
    below = true;
  }
  const left = Math.max(4, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 4));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.classList.toggle('below', below);
}

function show(el: Element) {
  const text = adoptTitle(el);
  if (!text) return;
  const tip = ensureTip();
  tip.textContent = text;
  if (!tip.isConnected) document.body.append(tip);
  tip.classList.remove('visible');
  place(el);
  el.setAttribute('aria-describedby', tip.id);
  // next frame so the fade-in transition runs
  requestAnimationFrame(() => tip.classList.add('visible'));
}

function hide() {
  clearTimeout(showTimer);
  if (current) current.removeAttribute('aria-describedby');
  current = null;
  if (tipEl?.isConnected) {
    tipEl.classList.remove('visible');
    tipEl.remove();
    lastHide = performance.now();
  }
}

function schedule(el: Element) {
  if (el === current) return;
  hide();
  current = el;
  adoptTitle(el); // suppress the native tooltip right away
  const instant = performance.now() - lastHide < SKIP_DELAY_WINDOW;
  showTimer = window.setTimeout(() => current === el && show(el), instant ? 0 : SHOW_DELAY);
}

let installed = false;

export function installTooltips(root: Document = document) {
  if (installed) return;
  installed = true;

  root.addEventListener(
    'pointerover',
    (e) => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      const el = findTarget(e.target);
      if (el) schedule(el);
      else if (current && !(e.target instanceof Node && current.contains(e.target))) hide();
    },
    true,
  );
  root.addEventListener(
    'pointerout',
    (e) => {
      if (!current) return;
      const to = (e as PointerEvent).relatedTarget as Node | null;
      if (!to || !current.contains(to)) hide();
    },
    true,
  );
  root.addEventListener('pointerdown', hide, true);
  root.addEventListener('focusin', (e) => {
    const el = findTarget(e.target);
    // Only for keyboard focus, not focus caused by a click.
    if (el && (e.target as Element).matches(':focus-visible')) schedule(el);
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);

  // Titles set later (e.g. button.title = …) are adopted the moment they appear.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof Element && r.target.hasAttribute('title')) {
        const el = r.target;
        if (el.closest('svg') === el || el.hasAttribute('data-native-title')) continue;
        adoptTitle(el);
        if (el === current && tipEl?.isConnected) {
          tipEl.textContent = el.getAttribute('data-tip') ?? '';
          place(el);
        }
      }
    }
  }).observe(root.documentElement, { attributes: true, attributeFilter: ['title'], subtree: true });
}
