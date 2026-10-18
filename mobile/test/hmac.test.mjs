// node --test mobile/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, hmacHex, hexEqual } from '../src/hmac.js';

const nodeHmac = (k, t) => crypto.createHmac('sha256', k).update(t).digest('hex');

test('sha256 matches node for many lengths (padding edge cases)', () => {
  for (let len = 0; len < 200; len++) {
    const data = crypto.randomBytes(len);
    const ours = Buffer.from(sha256(new Uint8Array(data))).toString('hex');
    assert.equal(ours, crypto.createHash('sha256').update(data).digest('hex'), `length ${len}`);
  }
});

test('hmacHex matches node, including keys longer than one block', () => {
  for (const key of ['', 'c0cb5523ab12', 'x'.repeat(64), 'k'.repeat(100), 'ключ🔑']) {
    for (const text of ['', 'phone|abc|def', 'p|1|{"type":"hello"}', 'z'.repeat(1000)]) {
      assert.equal(hmacHex(key, text), nodeHmac(key, text));
    }
  }
});

test('hexEqual', () => {
  assert.ok(hexEqual('abcd', 'abcd'));
  assert.ok(!hexEqual('abcd', 'abce'));
  assert.ok(!hexEqual('abcd', 'abc'));
  assert.ok(!hexEqual(undefined, 'abc'));
});
