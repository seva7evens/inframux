import assert from 'node:assert/strict';
import test from 'node:test';

import { renderOnboardingHuman } from '../../src/cli/onboarding-ui.js';

const sessionId = '018f47d2-8737-7a19-8000-123456789abc';

test('renders a configuration journey without exposing the raw session object', () => {
  const output = renderOnboardingHuman('onboard.start', {
    schema: 1, id: sessionId, project: 'example', state: 'configuration-required', complete: false,
    plan: [{ id: 'vercel', auth: 'static-token' }], services: {},
    nextActions: [{ type: 'configure-provider', actor: 'agent',
      command: `inframux onboard configure ${sessionId} --service vercel --input-json '<non-secret-json>' --json`,
      description: 'Configure Vercel.', interactive: false, privileged: false }],
  }, { unicode: false });
  assert.match(output, /inframux onboarding started/i);
  assert.match(output, /Project: example/);
  assert.match(output, /Next step — agent:/);
  assert.match(output, /onboard configure/);
  assert.doesNotMatch(output, /"services"|"schema"/);
});

test('renders authorization handoff and completed post-checks distinctly', () => {
  const authorized = renderOnboardingHuman('onboard.authorize', {
    schema: 1, id: sessionId, project: 'example', providers: ['sentry', 'vercel'],
    services: { sentry: { profile: 'example-sentry-admin' }, vercel: { profile: 'example-vercel-admin' } },
    state: 'ready-to-finish', complete: false,
    nextActions: [{ type: 'finish-onboarding', actor: 'agent', command: `inframux onboard finish ${sessionId} --json`,
      description: 'Finish onboarding.', interactive: false, privileged: false }],
  }, { unicode: true });
  assert.match(authorized, /✓ 2 of 2 services connected/);
  assert.match(authorized, /Repository trust is still pending/);

  const completed = renderOnboardingHuman('onboard.finish', {
    schema: 1, project: 'example', providers: ['sentry', 'vercel'], state: 'complete', complete: true,
    agentInstructions: '# instructions',
    nextActions: [
      { type: 'inspect-status', actor: 'agent', command: 'inframux status --json', description: 'Inspect.', interactive: false, privileged: false },
      { type: 'verify-health', actor: 'agent', command: 'inframux doctor --json', description: 'Verify.', interactive: false, privileged: false },
    ],
  }, { unicode: true });
  assert.match(completed, /✓ inframux onboarding complete/);
  assert.match(completed, /Checkout trust: approved/);
  assert.match(completed, /inframux doctor --json/);
  assert.doesNotMatch(completed, /# instructions/);
});
