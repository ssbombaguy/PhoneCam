import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

// Android-only helpers for streaming (see android/src/main/java/...).
// Every function is a safe no-op if the native module isn't available.
const Native = Platform.OS === 'android' ? requireOptionalNativeModule('PhonecamNative') : null;

export function startStreamingService(title, text) {
  try { Native?.startService(title, text); } catch (e) { console.warn('[PhoneCam] service', e); }
}

export function stopStreamingService() {
  try { Native?.stopService(); } catch { /* not running */ }
}

export function lockLandscape(lock) {
  try { Native?.lockLandscape(lock); } catch { /* ignore */ }
}

// -> { supported, torch, torchOn, maxZoom, zoom, focus }
export async function setCameraState(trackId, { torch = false, zoom = 1, focus = null } = {}) {
  if (!Native || !trackId) return { supported: false };
  try {
    return await Native.setCameraState(trackId, torch, zoom, focus ? focus.x : -1, focus ? focus.y : -1);
  } catch (e) {
    return { supported: false, error: String(e?.message || e) };
  }
}
