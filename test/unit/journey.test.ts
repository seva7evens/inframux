import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJourneyAction,
  createJourneyProjection,
  journeyError,
  withJourney,
} from '../../src/cli/journey.js';
import { renderError, renderResult } from '../../src/cli/render.js';

test('adds one immutable deterministic journey to an existing machine result', () => {
  const configure = createJourneyAction({
    type: 'configure-provider', actor: 'agent',
    command: 'inframux onboard configure 018f47d2-8737-7a19-8000-123456789abc --service vercel --input-json \'{}\' --json',
    description: 'Configure Vercel identity pins.', interactive: false, privileged: false,
  });
  const authorize = createJourneyAction({
    type: 'authorize-providers', actor: 'user',
    command: 'inframux onboard authorize 018f47d2-8737-7a19-8000-123456789abc',
    description: 'Authorize configured services.', interactive: true, privileged: false,
  });
  const projection = createJourneyProjection('configuration-required', false, [configure, authorize]);
  const result = withJourney({ schema: 1, id: '018f47d2-8737-7a19-8000-123456789abc' }, projection);

  assert.deepEqual(result, {
    schema: 1,
    id: '018f47d2-8737-7a19-8000-123456789abc',
    state: 'configuration-required',
    complete: false,
    nextActions: [configure, authorize],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nextActions), true);
  assert.equal(Object.isFrozen(result.nextActions[0]), true);
  assert.deepEqual(JSON.parse(renderResult('onboard.start', result, { json: true, verbose: false })), result);
});

test('rejects actions that could inject terminal output or shell separators', () => {
  const base = {
    type: 'authorize-providers', actor: 'user' as const,
    description: 'Authorize services.', interactive: true, privileged: false,
  };
  assert.throws(() => createJourneyAction({ ...base, command: 'inframux status\nforged' }), /safe command/i);
  assert.throws(() => createJourneyAction({ ...base, command: 'inframux status\u001b[2J' }), /safe command/i);
  assert.throws(() => createJourneyAction({ ...base, command: 'inframux status; rm something' }), /safe command/i);
});

test('renders an action-bearing machine error and preserves legacy recovery', () => {
  const action = createJourneyAction({
    type: 'authorize-providers', actor: 'user',
    command: 'inframux onboard authorize 018f47d2-8737-7a19-8000-123456789abc',
    description: 'Authorize the remaining services.', interactive: true, privileged: false,
  });
  const error = journeyError(
    'SESSION_AUTHORIZATION_REQUIRED',
    'Two services still require authorization.',
    createJourneyProjection('authorization-required', false, [action]),
  );
  const rendered = renderError(error, true);

  assert.equal(rendered.exitCode, 34);
  assert.deepEqual(JSON.parse(rendered.text), {
    schema: 1,
    error: {
      code: 'SESSION_AUTHORIZATION_REQUIRED',
      message: 'Two services still require authorization.',
      recovery: action.command,
    },
    state: 'authorization-required',
    complete: false,
    nextActions: [action],
  });
});
