import assert from 'node:assert/strict';
import test from 'node:test';

import { detectTerminalCapabilities, sanitizeTerminalText } from '../../src/cli/terminal.js';

test('enables animation only for an interactive human terminal', () => {
  assert.deepEqual(detectTerminalCapabilities({ isTTY: true, environment: { TERM: 'xterm-256color' }, columns: 120, json: false }), {
    interactive: true, color: true, unicode: true, animation: true, columns: 120,
  });
  for (const input of [
    { isTTY: false, environment: {}, json: false },
    { isTTY: true, environment: { CI: 'true' }, json: false },
    { isTTY: true, environment: { TERM: 'dumb' }, json: false },
    { isTTY: true, environment: {}, json: true },
  ]) assert.equal(detectTerminalCapabilities(input).animation, false);
  assert.equal(detectTerminalCapabilities({ isTTY: true, environment: { NO_COLOR: '1' }, json: false }).color, false);
});

test('sanitizes provider-controlled terminal text and bounds its length', () => {
  assert.equal(sanitizeTerminalText('safe\u001b[2J\nforged', 20), 'safeforged');
  assert.equal(sanitizeTerminalText('123456789', 5), '12345');
});
