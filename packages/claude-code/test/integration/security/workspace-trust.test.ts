// Setting sources at the real CLI (W6-T4; plan §2.4 `workspaceTrust`,
// §2.5; ADR-0012 §2): what a workspace can make the CLI do under
// `workspaceTrust: 'none'` (the default, `--setting-sources=user`) and under
// `'full'` (`user,project,local`).
//
// Evidence: 07 §10 (W133, L95; Windows and Linux identical): with project
// sources the CLI loads CLAUDE.md, runs project hooks, spawns project MCP
// servers and applies the project env without any trust; with `user` alone
// none of it. 05 §13.1 and 08 §5: the ancestor `~/.claude` and CLAUDE.md
// lookups walk ancestors, settings files never do. Every marker file lies in
// the sandbox; the hook and the MCP "server" only write a marker.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { allowAll, b64, collect, rawOf, requestsWith, writeJson } from './support.js';

const suite = integrationSuite();

const CLAUDE_MD_MARKER = 'hudhud-it-claude-md-marker';

/** An MCP stdio "server" that writes `marker` and exits (it never answers). */
function markerServer(
  marker: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/c', `echo mcp>${marker}`] }
    : { command: '/bin/sh', args: ['-c', `echo mcp > '${marker}'`] };
}

for (const trust of ['none', 'full'] as const) {
  test(`workspaceTrust '${trust}': project CLAUDE.md, env, hooks and MCP ${trust === 'full' ? 'load' : 'stay out'} (07 §10 w1, w5)`, async () => {
    const sandbox = await suite.sandbox();
    const cwd = path.join(sandbox.dirs.work, 'project');
    const hookMarker = path.join(cwd, 'hook-marker.txt');
    const mcpMarker = path.join(cwd, 'mcp-marker.txt');
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      env: { HUDHUD_PROJECT_ENV: 'project-env-value' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'echo "hook $HUDHUD_PROJECT_ENV" > hook-marker.txt' },
            ],
          },
        ],
      },
    });
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: { 'hudhud-probe': markerServer(mcpMarker, sandbox.platform) },
    });
    writeFileSync(path.join(cwd, 'CLAUDE.md'), `${CLAUDE_MD_MARKER}\n`);

    const harness = await suite.testConnect();
    const session = await harness.sessions.create({
      cwd,
      workspaceTrust: trust,
      onPermission: allowAll,
    });
    const collected = collect(session);
    const result = await session.ask(
      `[[mock:bash cmd=${b64('echo "env=[$HUDHUD_PROJECT_ENV]"')}]] trust-${trust}`,
    );
    await session.close();
    await collected.done;

    const full = trust === 'full';
    expect(result.outcome).toBe('completed');
    // Project env in the tool's environment.
    expect(result.text).toContain(full ? 'env=[project-env-value]' : 'env=[]');
    // The PreToolUse hook ran before the Bash tool, with the project env.
    expect(existsSync(hookMarker)).toBe(full);
    if (full) expect(readFileSync(hookMarker, 'utf8')).toContain('hook project-env-value');
    // The project MCP server was spawned (it wrote its marker) and listed.
    expect(existsSync(mcpMarker)).toBe(full);
    const init = rawOf(collected.events, 'turn.started') as { mcp_servers?: unknown } | undefined;
    expect(init?.mcp_servers).toEqual(
      full ? [expect.objectContaining({ name: 'hudhud-probe', source: 'project' })] : [],
    );
    // CLAUDE.md reached the model request only with project sources.
    const mock = await suite.mock();
    const withMarker = mock.requests.filter((request) =>
      JSON.stringify(request.body).includes(CLAUDE_MD_MARKER),
    );
    expect(withMarker.length > 0).toBe(full);
    expect(requestsWith(mock, `trust-${trust}`).length).toBeGreaterThan(0);
  });
}

/** The sandbox home's `.claude` and the cwd the session runs in. */
type HomeVariant = 'ancestor-none' | 'ancestor-full' | 'home-full';

for (const variant of [
  'ancestor-none',
  'ancestor-full',
  'home-full',
] as const satisfies readonly HomeVariant[]) {
  test(`sandbox home .claude: ${variant} (05 §13.1, 08 §2 d, 08 §5)`, async () => {
    const sandbox = await suite.sandbox();
    const dot = path.join(sandbox.dirs.home, '.claude');
    const skill = path.join(dot, 'skills', 'hudhud-it-home-skill');
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      path.join(skill, 'SKILL.md'),
      '---\nname: hudhud-it-home-skill\ndescription: marker skill of the sandbox home\n---\nmarker\n',
    );
    writeFileSync(path.join(dot, 'CLAUDE.md'), `${CLAUDE_MD_MARKER}\n`);
    writeJson(path.join(dot, 'settings.json'), { env: { HUDHUD_HOME_ENV: 'home-env-value' } });
    // `ancestor-*`: the home is an ancestor of the cwd (05 §13.1);
    // `home-full`: the application asks for the home itself as the project.
    const cwd =
      variant === 'home-full' ? sandbox.dirs.home : path.join(sandbox.dirs.home, 'project');
    mkdirSync(cwd, { recursive: true });

    const harness = await suite.testConnect();
    const session = await harness.sessions.create({
      cwd,
      onPermission: allowAll,
      ...(variant === 'ancestor-none' ? {} : { workspaceTrust: 'full' as const }),
    });
    const collected = collect(session);
    const result = await session.ask(
      `[[mock:bash cmd=${b64('echo "env=[$HUDHUD_HOME_ENV]"')}]] home`,
    );
    await session.close();
    await collected.done;

    const bodies = JSON.stringify((await suite.mock()).requests.map((request) => request.body));
    const init = JSON.stringify(rawOf(collected.events, 'turn.started'));
    // The home's skills never load: the user tier is the isolated config
    // directory (`CLAUDE_CONFIG_DIR`), not `~/.claude`.
    expect(init.includes('hudhud-it-home-skill')).toBe(false);
    expect(bodies.includes('hudhud-it-home-skill')).toBe(false);
    // Settings env: only when the home is the project itself (08: never
    // from an ancestor).
    expect(result.text).toContain(variant === 'home-full' ? 'env=[home-env-value]' : 'env=[]');
    // CLAUDE.md: never under 'none'; with project sources the CLI's own
    // ancestor walk reads `<ancestor>/.claude/CLAUDE.md` (08 §5 q1, q2).
    expect(bodies.includes(CLAUDE_MD_MARKER)).toBe(variant !== 'ancestor-none');
  });
}
