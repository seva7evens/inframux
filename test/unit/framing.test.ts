import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameDecoder, decodeJsonFrame, encodeFrame } from '../../src/ipc/framing.js';
import { parseWireMessage } from '../../src/ipc/messages.js';

test('decodes partial and coalesced bounded frames without losing byte boundaries', () => {
  const first = encodeFrame(Buffer.from('{"one":1}'));
  const second = encodeFrame(Buffer.from('{"two":2}'));
  const decoder = new FrameDecoder({ maxFrameBytes: 64 });

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  const completed = decoder.push(Buffer.concat([first.subarray(3), second]));
  assert.deepEqual(completed.map((frame) => frame.toString('utf8')), ['{"one":1}', '{"two":2}']);
  assert.equal(decoder.pendingBytes, 0);
});

test('rejects zero, oversized, invalid UTF-8, invalid JSON, and trailing partial frames', () => {
  const zero = Buffer.alloc(4);
  assert.throws(() => new FrameDecoder().push(zero), /zero-length/i);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(65);
  assert.throws(() => new FrameDecoder({ maxFrameBytes: 64 }).push(oversized), /exceeds.*64/i);
  assert.throws(() => decodeJsonFrame(Buffer.from([0xff])), /utf-8/i);
  assert.throws(() => decodeJsonFrame(Buffer.from('{nope')), /json/i);

  const decoder = new FrameDecoder();
  decoder.push(Buffer.from([0, 0, 0, 5, 0x7b]));
  assert.throws(() => decoder.finish(), /partial frame/i);
});

test('accepts current and previous minor messages but rejects major, old minor, and unknown fields', () => {
  const base = {
    kind: 'cancel',
    id: '0198b443-f1c2-7b2f-a7b1-88e305891234',
  };
  assert.equal(parseWireMessage({ ...base, protocol: { major: 1, minor: 1 } }).kind, 'cancel');
  assert.equal(parseWireMessage({ ...base, protocol: { major: 1, minor: 0 } }).kind, 'cancel');
  assert.throws(() => parseWireMessage({ ...base, protocol: { major: 2, minor: 0 } }), /protocol/i);
  assert.throws(() => parseWireMessage({ ...base, protocol: { major: 1, minor: -1 } }), /protocol/i);
  assert.throws(() => parseWireMessage({ ...base, protocol: { major: 1, minor: 1 }, extra: true }), /unrecognized key/i);
});
