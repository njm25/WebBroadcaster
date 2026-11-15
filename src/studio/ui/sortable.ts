// Drag-to-reorder for vertical lists (Scenes, Sources, …). Shared helper.
//
// Press on a row and drag (≥ 4px, so clicks and double-clicks still work):
// the row follows the pointer as a floating copy, an insertion line shows
// where it will land, and the list auto-scrolls near its edges. Esc cancels.
// Uses pointer events (not HTML5 drag-and-drop) so it never clashes with the
// docking system's own panel dragging.

export interface SortableOptions {
  /** Selector for draggable rows inside the list. */
  rows: string;
  /** Id of a row element. */
  idOf: (row: HTMLElement) => string;
  /** Called on drop with the row id and its new position in the visible list (0 = top). */
  onDrop: (id: string, visualIndex: number) => void;
  /** Rows that can't be dragged (e.g. locked items). */
  canDrag?: (row: HTMLElement) => boolean;
}

export function makeSortable(list: HTMLElement, opts: SortableOptions) {
  let drag: {
    row: HTMLElement;
    id: string;
    pointerId: number;
    startY: number;
    offsetY: number;
    started: boolean;
    ghost: HTMLElement | null;
    line: HTMLElement | null;
    target: number;
    scrollTimer: number | undefined;
    lastY: number;
  } | null = null;

  const others = () => [...list.querySelectorAll<HTMLElement>(opts.rows)].filter((r) => r !== drag?.row);

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const t = e.target as Element;
    if (t.closest('button, input, select, textarea, .cs')) return; // row buttons keep working
    const row = t.closest<HTMLElement>(opts.rows);
    if (!row || !list.contains(row) || (opts.canDrag && !opts.canDrag(row))) return;
    const r = row.getBoundingClientRect();
    drag = {
      row,
      id: opts.idOf(row),
      pointerId: e.pointerId,
      startY: e.clientY,
      offsetY: e.clientY - r.top,
      started: false,
      ghost: null,
      line: null,
      target: -1,
      scrollTimer: undefined,
      lastY: e.clientY,
    };
  });

  const begin = () => {
    if (!drag) return;
    drag.started = true;
    try {
      list.setPointerCapture(drag.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const r = drag.row.getBoundingClientRect();
    const ghost = drag.row.cloneNode(true) as HTMLElement;
    ghost.classList.add('sort-ghost');
    Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
    document.body.append(ghost);
    drag.ghost = ghost;
    const line = document.createElement('div');
    line.className = 'sort-line';
    document.body.append(line);
    drag.line = line;
    drag.row.classList.add('sort-source');
    document.body.classList.add('sorting');
    // Auto-scroll when hovering near the top/bottom edge.
    drag.scrollTimer = window.setInterval(() => {
      if (!drag) return;
      const lr = list.getBoundingClientRect();
      const edge = 28;
      if (drag.lastY < lr.top + edge) list.scrollTop -= 8;
      else if (drag.lastY > lr.bottom - edge) list.scrollTop += 8;
      else return;
      update(drag.lastY);
    }, 16);
  };

  const update = (y: number) => {
    if (!drag?.ghost || !drag.line) return;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
    const rows = others();
    // Insertion index = number of other rows whose middle is above the pointer.
    let idx = 0;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (y > b.top + b.height / 2) idx++;
    }
    drag.target = idx;
    const lr = list.getBoundingClientRect();
    let lineY: number;
    if (!rows.length) lineY = lr.top + 4;
    else if (idx < rows.length) lineY = rows[idx].getBoundingClientRect().top - 1;
    else lineY = rows[rows.length - 1].getBoundingClientRect().bottom + 1;
    lineY = Math.max(lr.top + 1, Math.min(lr.bottom - 2, lineY));
    Object.assign(drag.line.style, { top: `${lineY}px`, left: `${lr.left + 6}px`, width: `${lr.width - 12}px` });
  };

  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastY = e.clientY;
    if (!drag.started) {
      if (Math.abs(e.clientY - drag.startY) < 4) return;
      begin();
    }
    update(e.clientY);
  });

  const finish = (commit: boolean) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearInterval(d.scrollTimer);
    d.ghost?.remove();
    d.line?.remove();
    d.row.classList.remove('sort-source');
    document.body.classList.remove('sorting');
    try {
      if (list.hasPointerCapture(d.pointerId)) list.releasePointerCapture(d.pointerId);
    } catch {
      /* ignore */
    }
    if (d.started) {
      // Swallow the click that follows a drag so it doesn't also select/activate.
      list.addEventListener('click', (ev) => ev.stopPropagation(), { capture: true, once: true });
      if (commit && d.target >= 0) opts.onDrop(d.id, d.target);
    }
  };
  list.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) finish(true);
  });
  list.addEventListener('pointercancel', () => finish(false));
  document.addEventListener(
    'keydown',
    (e) => {
      if (drag?.started && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      }
    },
    true,
  );

  return {
    /** True while a row is being dragged (lists should hold re-renders). */
    get active() {
      return !!drag?.started;
    },
  };
}
