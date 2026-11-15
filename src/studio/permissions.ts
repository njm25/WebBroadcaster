// Camera / microphone permission handling for the studio computer's own devices.

export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown';
export type MediaKind = 'camera' | 'microphone';

export const BLOCKED_HELP =
  'Access is blocked for this site. Click the icon at the left of the address bar, set Camera and Microphone to "Allow", then try again.';

export async function permissionState(kind: MediaKind): Promise<PermState> {
  try {
    const s = await navigator.permissions.query({ name: kind as PermissionName });
    return s.state as PermState;
  } catch {
    return 'unknown'; // e.g. Firefox/Safari without this permission name
  }
}

/** Call `cb` whenever camera or microphone permission changes. */
export function onPermissionChange(cb: () => void) {
  for (const kind of ['camera', 'microphone'] as MediaKind[]) {
    navigator.permissions
      ?.query({ name: kind as PermissionName })
      .then((s) => s.addEventListener('change', cb))
      .catch(() => {});
  }
}

export type RequestResult = { ok: true } | { ok: false; reason: 'denied' | 'notfound' | 'error'; message: string };

/**
 * Show the browser's permission prompt (if needed) by briefly opening the
 * devices, then release them. Afterwards device labels and ids are available.
 */
export async function requestMedia(want: { video?: boolean; audio?: boolean }): Promise<RequestResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'error', message: 'This page needs HTTPS (or localhost) to use cameras and microphones.' };
  }
  const attempt = async (c: MediaStreamConstraints) => {
    const s = await navigator.mediaDevices.getUserMedia(c);
    s.getTracks().forEach((t) => t.stop());
  };
  try {
    await attempt({ video: !!want.video, audio: !!want.audio });
    return { ok: true };
  } catch (e) {
    const name = (e as DOMException).name;
    // Asked for both but one kind is missing: retry with what exists.
    if (name === 'NotFoundError' && want.video && want.audio) {
      for (const single of [{ video: true }, { audio: true }]) {
        try {
          await attempt(single);
          return { ok: true };
        } catch {
          /* try next */
        }
      }
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') return { ok: false, reason: 'denied', message: BLOCKED_HELP };
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return { ok: false, reason: 'notfound', message: 'No camera or microphone was found on this computer.' };
    }
    if (name === 'NotReadableError') {
      return { ok: false, reason: 'error', message: 'The device is in use by another app or failed to start. Close other apps using it and try again.' };
    }
    return { ok: false, reason: 'error', message: (e as Error).message || String(e) };
  }
}
