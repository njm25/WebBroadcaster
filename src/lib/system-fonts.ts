// Fonts installed on this computer, via the Local Font Access API
// (Chrome / Edge desktop). The browser asks permission once; after that the
// list loads without asking. Text is rendered by the studio computer, so only
// that computer needs the fonts.

type LocalFontData = { family: string };
type QueryLocalFonts = () => Promise<LocalFontData[]>;

const query = (): QueryLocalFonts | null =>
  typeof (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts === 'function'
    ? (window as unknown as { queryLocalFonts: QueryLocalFonts }).queryLocalFonts.bind(window)
    : null;

let families: string[] | null = null;
let loading: Promise<string[]> | null = null;

/** Can this browser list installed fonts at all? */
export const systemFontsSupported = () => !!query() && window.isSecureContext;

/** Already-loaded installed font families (null until loaded). */
export const loadedSystemFonts = () => families;

/**
 * Load installed font families. Call from a click/selection the first time:
 * the browser shows its permission prompt only in response to user input.
 */
export function loadSystemFonts(): Promise<string[]> {
  if (families) return Promise.resolve(families);
  const q = query();
  if (!q) return Promise.reject(new Error('This browser cannot list installed fonts. Use Chrome or Edge.'));
  loading ??= q()
    .then((fonts) => {
      families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      return families;
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** If permission was granted before, load the list now without prompting. */
export async function preloadSystemFontsIfAllowed(): Promise<string[] | null> {
  if (!systemFontsSupported()) return null;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    if (status.state !== 'granted') return null;
    return await loadSystemFonts();
  } catch {
    return null;
  }
}

/** CSS font-family value for an installed family (quoted, with a fallback). */
export const fontStack = (family: string) => `"${family.replace(/"/g, '')}", sans-serif`;

/** The first family name in a font-family value, unquoted. */
export const primaryFamily = (stack: string) => stack.split(',')[0].trim().replace(/^["']|["']$/g, '');
