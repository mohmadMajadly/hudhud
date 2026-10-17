// connect() once, inspect what it found, then open sessions on it.
// Guide: docs/guide/sessions.md, docs/guide/diagnostics.md

import process from 'node:process';

import { connect, postureDeviations } from 'hudhudjs';

const harness = await connect();
try {
  const { binary, compat, capabilities } = harness;
  console.log(`Claude Code ${binary.version} at ${binary.path} (found by: ${binary.source})`);
  console.log(`verification: ${binary.verification.status} (${binary.verification.method})`);
  console.log(`compat: ${compat.status}, tested ${compat.minTested} to ${compat.maxTested}`);
  console.log(`process containment: ${capabilities.processContainment}`);
  for (const [capability, reason] of Object.entries(capabilities.reasons)) {
    console.log(`  ${capability}: ${reason}`);
  }
  for (const entry of postureDeviations(harness.securityPosture)) {
    console.log(`security posture deviates: ${entry.setting} = ${JSON.stringify(entry.value)}`);
  }

  const session = await harness.sessions.create({ cwd: process.cwd() });
  try {
    const { info } = session;
    console.log(`session ${info.id}: pid ${String(info.pid)}, containment ${info.containment}`);
    const result = await session.ask('What is 6 times 7?');
    console.log(result.text);
  } finally {
    await session.close();
  }
} finally {
  // Disposing the Harness also disposes every session it still has.
  await harness[Symbol.asyncDispose]();
}
