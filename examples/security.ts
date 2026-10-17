// Changing security defaults on purpose: each change below is visible in
// securityPosture and in the session's `security.posture` diagnostic.
// Guide: docs/guide/security.md

import { connect, postureDeviations } from 'hudhudjs';

// Refuse any binary whose signature and digest cannot both be verified.
const harness = await connect({ binaryVerification: 'strict' });
try {
  const session = await harness.sessions.create({
    // Load the repository's own Claude Code configuration: project settings,
    // CLAUDE.md, hooks and MCP servers. projectCredentialEnv stays 'refuse',
    // so a repository that redirects API traffic or credentials is refused.
    workspaceTrust: 'full',
    // The default allowlist, minus the proxy variable, plus one named variable.
    env: { preset: 'harness', remove: ['HTTPS_PROXY'], add: { GIT_AUTHOR_NAME: 'Build Bot' } },
    // Narrow the tools the agent may use.
    claudeCode: {
      allowedTools: ['Read', 'Grep', 'Bash(git status:*)'],
      disallowedTools: ['WebFetch'],
    },
  });
  try {
    await session.ask('Summarize the open changes in this repository.');
  } finally {
    await session.close();
  }

  for (const entry of postureDeviations(harness.securityPosture)) {
    console.log(`${entry.setting}: ${JSON.stringify(entry.value)}`);
  }
} finally {
  await harness[Symbol.asyncDispose]();
}
