// W6-Z ruling 5, against the real Vitest runner: the harness's after-test
// checks run even when a test file's own `afterEach`, registered after the
// harness's hooks (so run before them), throws. Vitest runs `afterEach`
// hooks in reverse order of registration and stops at the first that
// throws; the checks therefore run as the test's `onTestFinished` hook.

import { afterAll, afterEach, beforeAll, beforeEach, expect, onTestFinished, test } from 'vitest';

import { registerIntegrationHooks } from '../../src/launcher/integration.js';
import type { SuiteLifecycle } from '../../src/launcher/integration.js';

const calls: string[] = [];

const lifecycle: SuiteLifecycle = {
  beginSuite: () => {
    calls.push('beginSuite');
    return Promise.resolve();
  },
  beginTest: () => {
    calls.push('beginTest');
  },
  endTest: () => {
    calls.push('endTest');
    return Promise.resolve();
  },
  endSuite: () => Promise.resolve(),
};

registerIntegrationHooks(lifecycle, { beforeAll, afterAll, beforeEach, onTestFinished });

// The test file's own hook, registered after the harness's.
afterEach((context) => {
  if (context.task.name.startsWith('a failing afterEach')) {
    calls.push('user afterEach throws');
    throw new Error('the test file afterEach failed');
  }
});

// `test.fails`: the afterEach failure is this test's expected failure.
test.fails('a failing afterEach of the test file fails the test', () => {
  calls.push('test');
});

test('the harness still ran its after-test checks for that test, after the hook', () => {
  expect(calls).toEqual([
    'beginSuite',
    'beginTest',
    'test',
    'user afterEach throws',
    'endTest',
    'beginTest',
  ]);
});
