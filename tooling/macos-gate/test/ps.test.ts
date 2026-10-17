import { describe, expect, it } from 'vitest';

import {
  PS_ARGS as CORE_PS_ARGS,
  PS_ENV as CORE_PS_ENV,
  PS_PATH as CORE_PS_PATH,
} from '../../../packages/core/src/process/os/darwin.js';
import {
  commandName,
  identityLabel,
  liveIdentity,
  ProcessLedger,
  PS_ARGS,
  PS_ENV,
  PS_PATH,
  psRawLines,
  psSnapshot,
  recordLabel,
} from '../src/ps.js';
import { SimHost, T0 } from './sim.js';

/** A CLI-like root with a Bash tool group (`zsh` leading `sleep`) and a helper in the root's group. */
function tree(sim: SimHost): { root: number; shell: number; sleep: number; helper: number } {
  const root = sim.addProcess(sim.pid, '/tmp/claude', false);
  const shell = sim.addProcess(root.pid, '/bin/zsh', true);
  const sleep = sim.addProcess(shell.pid, '/bin/sleep', false);
  const helper = sim.addProcess(root.pid, 'helper', false);
  return { root: root.pid, shell: shell.pid, sleep: sleep.pid, helper: helper.pid };
}

describe('psSnapshot', () => {
  it('runs /bin/ps by absolute path with exactly LC_ALL=C and TZ=UTC0 and parses every line', async () => {
    const sim = new SimHost();
    tree(sim);
    const snapshot = await psSnapshot(sim);
    expect(sim.runs[0]).toEqual({
      file: PS_PATH,
      args: PS_ARGS,
      options: { env: PS_ENV, timeoutMs: 15_000 },
    });
    expect(PS_ARGS).toEqual(['-A', '-ww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,comm=']);
    expect(PS_ENV).toEqual({ LC_ALL: 'C', TZ: 'UTC0' });
    // The gate confirms the core's contract, so it runs exactly the core's ps.
    expect([PS_PATH, PS_ARGS, PS_ENV]).toEqual([CORE_PS_PATH, CORE_PS_ARGS, CORE_PS_ENV]);
    expect(snapshot.source).toBe('darwin-ps');
    expect(snapshot.rejected).toBe(0);
    expect(snapshot.records).toHaveLength(6);
    expect(snapshot.records.find((record) => record.pid === sim.pid)?.startTime).toBe(
      String(T0 / 1000 - 60),
    );
  });

  it('rejects when ps fails', async () => {
    const sim = new SimHost();
    sim.psFails = true;
    await expect(psSnapshot(sim)).rejects.toThrow(/\/bin\/ps failed: code 1/);
  });

  it('names commands by basename without the login-shell dash', () => {
    expect(commandName('/usr/bin/security')).toBe('security');
    expect(commandName('-zsh')).toBe('zsh');
    expect(identityLabel({ pid: 3, startTime: '9' })).toBe('3@9');
  });

  it('names a (p_comm) entry by the kernel name inside the parentheses (gate run 1)', () => {
    expect(commandName('(security)')).toBe('security');
    expect(commandName('(xcodebuild)')).toBe('xcodebuild');
    expect(commandName('(a/b)')).toBe('a/b');
    expect(commandName('/tmp/(x)')).toBe('(x)');
    expect(commandName('(x')).toBe('(x');
  });

  it('parses the BSD layout exactly: no padding in names, zombies marked', async () => {
    const sim = new SimHost();
    const root = sim.addProcess(sim.pid, '/tmp/claude', false);
    const zombie = sim.addProcess(root.pid, '(git)', false);
    zombie.state = 'Z';
    const snapshot = await psSnapshot(sim);
    expect(snapshot.rejected).toBe(0);
    const byPid = new Map(snapshot.records.map((record) => [record.pid, record]));
    expect(byPid.get(root.pid)?.name).toBe('/tmp/claude');
    expect(byPid.get(zombie.pid)).toMatchObject({ name: '(git)', zombie: true });
    const dead = byPid.get(zombie.pid);
    expect(dead === undefined ? undefined : recordLabel(dead)).toBe('(git) [zombie]');
    const at = (pid: number, start: number): { pid: number; startTime: string } => ({
      pid,
      startTime: String(start),
    });
    expect(liveIdentity(snapshot.records, at(zombie.pid, zombie.start))).toBeNull();
    expect(liveIdentity(snapshot.records, at(root.pid, root.start))).toMatchObject({
      pid: root.pid,
    });
  });

  it('keeps the raw ps lines of the requested pids as evidence', async () => {
    const sim = new SimHost();
    const root = sim.addProcess(sim.pid, '/tmp/claude', false);
    const lines = await psRawLines(sim, [root.pid]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^ +\d+ +900 +900 S {4}\w{3} \w{3} [ \d]\d [\d:]{8} \d{4} {5}\/tmp\/claude$/,
    );
    sim.psFails = true;
    await expect(psRawLines(sim, [root.pid])).rejects.toThrow(/failed: code 1/);
  });
});

describe('ProcessLedger', () => {
  it('registers a live pid with its start time, and nothing for a gone pid', async () => {
    const sim = new SimHost();
    const { root } = tree(sim);
    const ledger = new ProcessLedger(sim);
    expect(await ledger.register(root)).toMatchObject({ pid: root, name: '/tmp/claude' });
    expect(await ledger.register(99_999)).toBeNull();
  });

  it('kills a live root and its verified tool group, then reports no survivor', async () => {
    const sim = new SimHost();
    const { root, shell, sleep, helper } = tree(sim);
    const ledger = new ProcessLedger(sim);
    const identity = await ledger.register(root);
    expect(identity).not.toBeNull();
    const view = await ledger.tree(identity ?? { pid: 0, startTime: '0' });
    expect(view.descendants.map((record) => record.pid)).toEqual([shell, helper, sleep]);
    const outcome = await ledger.sweep(identity ?? { pid: 0, startTime: '0' });
    expect(outcome.survivors).toEqual([]);
    expect(outcome.signalled).toContain(`${String(root)}@${String(T0 / 1000)}`);
    expect(outcome.signalled).toContain(`-${String(shell)}`);
    expect(sim.table.has(sleep)).toBe(false);
    expect(sim.table.has(helper)).toBe(false);
    // Done: a second sweep does nothing.
    expect(await ledger.sweep(identity ?? { pid: 0, startTime: '0' })).toEqual({
      signalled: [],
      survivors: [],
    });
  });

  it('never signals a pid whose start time changed (reuse) and reports nothing for it', async () => {
    const sim = new SimHost();
    const { root } = tree(sim);
    const ledger = new ProcessLedger(sim);
    const identity = await ledger.register(root);
    const record = sim.table.get(root);
    if (record !== undefined) record.start += 5;
    await ledger.sweep(identity ?? { pid: 0, startTime: '0' });
    expect(sim.signals.filter((entry) => entry.startsWith(`${String(root)}:`))).toEqual([]);
  });

  it('reports survivors when signals are refused, and retries them in sweepAll', async () => {
    const sim = new SimHost();
    const { root, sleep } = tree(sim);
    const ledger = new ProcessLedger(sim);
    const identity = await ledger.register(root);
    sim.denySignals = true;
    const first = await ledger.sweep(identity ?? { pid: 0, startTime: '0' });
    expect(first.signalled).toEqual([]);
    expect(first.survivors).toContain(`${String(sleep)}@${String(T0 / 1000)}`);
    sim.denySignals = false;
    const all = await ledger.sweepAll();
    expect(all.survivors).toEqual([]);
    expect(all.signalled.length).toBeGreaterThan(0);
    expect(await ledger.sweepAll()).toEqual({ signalled: [], survivors: [] });
  });

  it('sweeps an orphaned tool tree after its root died (reparented to launchd)', async () => {
    const sim = new SimHost();
    const { root, shell, sleep } = tree(sim);
    const ledger = new ProcessLedger(sim);
    const identity = await ledger.register(root);
    sim.remove(root);
    expect(sim.table.get(shell)?.ppid).toBe(1);
    const outcome = await ledger.sweep(identity ?? { pid: 0, startTime: '0' });
    expect(outcome.survivors).toEqual([]);
    expect(sim.table.has(sleep)).toBe(false);
  });

  it('keeps a bounded number of recorded snapshots, and none for done roots or roots without descendants', async () => {
    const sim = new SimHost();
    const lone = sim.addProcess(sim.pid, 'lone', false);
    const { root } = tree(sim);
    const ledger = new ProcessLedger(sim);
    const loneIdentity = await ledger.register(lone.pid);
    const identity = await ledger.register(root);
    for (let i = 0; i < 20; i += 1) ledger.observe(await psSnapshot(sim));
    const outcome = await ledger.sweep(identity ?? { pid: 0, startTime: '0' });
    expect(outcome.survivors).toEqual([]);
    ledger.observe(await psSnapshot(sim));
    expect((await ledger.sweep(loneIdentity ?? { pid: 0, startTime: '0' })).survivors).toEqual([]);
  });
});
