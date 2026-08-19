import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAgentIntegrationGuide, renderUniversalOnboardingPrompt } from '../../src/integration/agent-config.js';

test('generates repository instructions with automatic context and explicit clean browser escape hatch', () => {
  const guide = renderAgentIntegrationGuide({
    project: 'sample', providers: ['cloudflare', 'google-cloud', 'supabase'],
  });
  assert.match(guide, /automatically resolved from this exact approved Git checkout/i);
  assert.match(guide, /inframux call cloudflare api\.request/);
  assert.match(guide, /browser mcp persistent/);
  assert.match(guide, /browser mcp clean/);
  assert.doesNotMatch(guide, /auth sample|use sample|api[_-]?key|access[_-]?token/i);
});

test('generates a universal onboarding prompt with one user-editable placeholder', () => {
  const prompt = renderUniversalOnboardingPrompt();
  assert.match(prompt, /Services: <ENTER COMMA-SEPARATED SERVICES>/);
  assert.match(prompt, /inframux onboard start/);
  assert.match(prompt, /never ask.*secret.*chat/i);
  assert.match(prompt, /onboard authorize/);
  assert.equal((prompt.match(/<[^>]+>/g) ?? []).length, 1);
});
