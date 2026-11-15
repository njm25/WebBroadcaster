/** Tiny DOM helper: h('div.cls#id', {attrs}, ...children) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  props: Record<string, unknown> | null = null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [, name, rest] = /^([a-z0-9]+)(.*)$/i.exec(tag) ?? [, tag, ''];
  const el = document.createElement(name as K);
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k in el && typeof v !== 'string') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[storage] could not save ${key}`, err);
  }
}

/** Stable per-browser id so a device keeps its identity across reloads. */
export function persistentId(key: string): string {
  let id = '';
  try {
    id = localStorage.getItem(key) ?? '';
    if (!id) {
      id = uid('d');
      localStorage.setItem(key, id);
    }
  } catch {
    id = uid('d');
  }
  return id;
}

export function deviceInfo() {
  const ua = navigator.userAgent;
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  let platform = 'Computer';
  if (/iPhone/.test(ua)) platform = 'iPhone';
  else if (/iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))) platform = 'iPad';
  else if (/Android/.test(ua)) platform = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/Mac/.test(ua)) platform = 'Mac';
  else if (/Windows/.test(ua)) platform = 'Windows PC';
  else if (/Linux/.test(ua)) platform = 'Linux PC';
  return { ua, platform, mobile };
}

export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Keyed blob storage (IndexedDB) for uploaded images and other assets. */
export const assets = (() => {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('webbroadcaster', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('assets');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const store = (await db()).transaction('assets', mode).objectStore('assets');
    return new Promise<T>((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    put: (id: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, id)),
    get: (id: string) => tx<Blob | undefined>('readonly', (s) => s.get(id)),
    del: (id: string) => tx('readwrite', (s) => s.delete(id)),
  };
})();
