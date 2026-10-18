import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'phonecam.pairing';

// "phonecam://pair?host=192.168.1.20&port=8080&key=abc123" -> { host, port, key }
export function parsePairingUrl(text) {
  if (typeof text !== 'string' || !text.startsWith('phonecam://')) return null;
  const query = text.split('?')[1] || '';
  const params = {};
  for (const part of query.split('&')) {
    const [k, v = ''] = part.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return validate({ host: params.host, port: params.port, key: params.key });
}

// Only home/office network addresses: the camera must never be streamed to a
// server on the internet, even if someone sends a crafted pairing link.
export function isPrivateIPv4(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4 || parts.some((x) => !/^\d{1,3}$/.test(x))) return false;
  const [a, b, c, d] = parts.map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

export function validate({ host, port, key }) {
  const h = String(host || '').trim();
  const p = Number(port);
  const k = String(key || '').trim();
  if (!isPrivateIPv4(h) || !(Number.isInteger(p) && p > 0 && p < 65536) || !/^[0-9a-zA-Z]{8,64}$/.test(k)) return null;
  return { host: h, port: p, key: k };
}

export async function loadPairing() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? validate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function savePairing(pairing) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
  } catch {
    // Not fatal: the user just has to scan again next time.
  }
}
