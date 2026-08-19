import assert from 'node:assert/strict';
import test from 'node:test';

import { ProgressController } from '../../src/cli/progress.js';

test('animates one active line and clears it exactly once before success output', async () => {
  let output = '';
  const progress = new ProgressController({ write: (value) => { output += value; }, enabled: true, intervalMs: 5, unicode: true });
  progress.start('Verifying Supabase credentials…');
  await new Promise((resolve) => setTimeout(resolve, 18));
  progress.succeed('Supabase connected');
  progress.stop();
  assert.match(output, /[⠋⠙⠹⠸] Verifying Supabase credentials…/u);
  assert.match(output, /\r\u001b\[2K✓ Supabase connected\n$/u);
  assert.equal(output.endsWith('\r\u001b[2K'), false);
});

test('emits stable text without cursor controls when animation is disabled', () => {
  let output = '';
  const progress = new ProgressController({ write: (value) => { output += value; }, enabled: false, unicode: false });
  progress.start('Verifying Vercel credentials...');
  progress.succeed('Vercel connected');
  assert.equal(output, 'Verifying Vercel credentials...\n[ok] Vercel connected\n');
  assert.doesNotMatch(output, /\u001b/);
});
