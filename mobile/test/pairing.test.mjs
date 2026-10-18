// node --test mobile/test   (AsyncStorage is stubbed: only the pure functions are tested)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('@react-native-async-storage/async-storage', { defaultExport: {} });
const { parsePairingUrl, validate, isPrivateIPv4 } = await import('../src/pairing.js');

test('accepts home-network addresses only', () => {
  for (const ip of ['192.168.0.10', '10.0.0.5', '172.16.1.1', '172.31.255.255', '100.64.0.1']) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '127.0.0.1', '256.1.1.1', 'evil.com', '192.168.1', '1.2.3.4.5', '']) {
    assert.ok(!isPrivateIPv4(ip), ip);
  }
});

test('parses a valid pairing link', () => {
  assert.deepEqual(parsePairingUrl('phonecam://pair?host=192.168.100.4&port=8080&key=c0cb5523ab12'), {
    host: '192.168.100.4', port: 8080, key: 'c0cb5523ab12',
  });
});

test('rejects links that point to the internet or are malformed', () => {
  assert.equal(parsePairingUrl('phonecam://pair?host=203.0.113.9&port=8080&key=c0cb5523ab12'), null);
  assert.equal(parsePairingUrl('phonecam://pair?host=evil.example&port=8080&key=c0cb5523ab12'), null);
  assert.equal(parsePairingUrl('phonecam://pair?host=192.168.1.2&port=99999&key=c0cb5523ab12'), null);
  assert.equal(parsePairingUrl('phonecam://pair?host=192.168.1.2&port=8080&key=x'), null);
  assert.equal(parsePairingUrl('https://example.com'), null);
  assert.equal(parsePairingUrl(null), null);
});

test('validate trims and normalises', () => {
  assert.deepEqual(validate({ host: ' 10.0.0.2 ', port: '8080', key: ' abcdef123456 ' }), { host: '10.0.0.2', port: 8080, key: 'abcdef123456' });
});
