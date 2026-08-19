import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRuntimeVersion } from '../../src/core/version.js';

test('accepts the exact sealed runtime and rejects nearby Node versions', () => {
  assert.doesNotThrow(() => assertRuntimeVersion('v24.18.1'));
  assert.throws(
    () => assertRuntimeVersion('v24.18.0'),
    /requires Node\.js 24\.18\.1/,
  );
  assert.throws(
    () => assertRuntimeVersion('v25.0.0'),
    /requires Node\.js 24\.18\.1/,
  );
});
