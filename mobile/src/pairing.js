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

export function validate({ host, port, key }) {
  const h = String(host || '').trim();
  const p = Number(port);
  const k = String(key || '').trim();
  if (!/^[\w.-]+$/.test(h) || !(p > 0 && p < 65536) || !/^\w{4,64}$/.test(k)) return null;
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
