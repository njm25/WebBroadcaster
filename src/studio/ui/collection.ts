// Export / import the whole studio setup ("scene collection") as one JSON
// file: scenes, images, mixer settings, output settings and panel layout.

import { confirmDialog } from '../../lib/dialog';
import { assets, h, loadJSON, saveJSON } from '../../lib/util';
import type { Studio } from '../context';
import { toast } from './common';

const FORMAT = 1;

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

export async function exportCollection(studio: Studio) {
  const { store } = studio;
  const images: Record<string, string> = {};
  for (const s of store.scenes) {
    for (const it of s.items) {
      if (it.source.type !== 'image' || images[it.source.assetId]) continue;
      const blob = await assets.get(it.source.assetId);
      if (blob) images[it.source.assetId] = await blobToDataUrl(blob);
    }
  }
  const data = {
    app: 'WebBroadcaster',
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    scenes: store.scenes,
    transition: store.transition,
    duration: store.duration,
    images,
    mixer: loadJSON('wb.mixer', {}),
    output: loadJSON('wb.settings', {}),
    inputs: loadJSON('wb.inputs', []),
    layout: loadJSON('wb.layout', {}),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', {
    href: URL.createObjectURL(blob),
    download: `WebBroadcaster-scenes-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${store.scenes.length} scene${store.scenes.length === 1 ? '' : 's'}`);
}

export function importCollection(studio: Studio) {
  const input = h('input', { type: 'file', accept: 'application/json,.json' }) as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON.');
      return;
    }
    if (data.app !== 'WebBroadcaster' || !Array.isArray(data.scenes) || !data.scenes.length) {
      toast("That file isn't a WebBroadcaster scene collection.");
      return;
    }
    if ((data.format as number) > FORMAT) {
      toast('That collection was made by a newer version of WebBroadcaster.');
      return;
    }
    const ok = await confirmDialog(
      `Your current ${studio.store.scenes.length} scene(s) will be replaced with ${data.scenes.length} from "${file.name}".`,
      { title: 'Import scene collection?', okLabel: 'Import', danger: true },
    );
    if (!ok) return;

    for (const [id, url] of Object.entries((data.images as Record<string, string>) ?? {})) {
      try {
        await assets.put(id, await (await fetch(url)).blob());
      } catch {
        /* skip broken image */
      }
    }
    const scenes = data.scenes as { id: string }[];
    saveJSON('wb.scenes', {
      scenes,
      programId: scenes[0].id,
      previewId: scenes[0].id,
      studioMode: studio.store.studioMode,
      transition: data.transition ?? 'fade',
      duration: data.duration ?? 500,
    });
    if (data.mixer) saveJSON('wb.mixer', data.mixer);
    if (data.output) saveJSON('wb.settings', data.output);
    if (data.layout) saveJSON('wb.layout', data.layout);
    // Merge known inputs so offline sources keep their names.
    if (Array.isArray(data.inputs)) {
      const cur = loadJSON<{ id: string }[]>('wb.inputs', []);
      const ids = new Set(cur.map((i) => i.id));
      saveJSON('wb.inputs', [...cur, ...(data.inputs as { id: string }[]).filter((i) => !ids.has(i.id))]);
    }
    location.reload();
  };
  input.click();
}
