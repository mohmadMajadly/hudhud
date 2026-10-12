# 08 — Spike W0-T2: settings lookup of Claude Code CLI 2.1.296 (K5)

Date: 2026-10-12. Host: Windows 11 Home 10.0.26200, Node 24.19.0, Docker Desktop (Linux engine). Linux runs: `node:24-bookworm-slim` container, uid 1000 (`node`). **No macOS host was available; nothing here is verified on macOS** (macOS follows the POSIX code path statically, see §6).

Everything ran on the pinned 2.1.296 binaries against two local mocks, with the sandbox recipe of 05 §13.2 and the C3 method of 07 §9. No real API, no real credentials, no user install or user config was used.

Paths: `S` = scratchpad root. Script: `S/sandbox/driver/t21-settings-lookup.mjs` (one file, 35 cases, optional case-prefix filter). Raw evidence: `S/sandbox/run/136-s21-settings-lookup/` (Windows, W136), `S/sandbox/run-linux/96-s21-settings-lookup/` (Linux, L96) and `S/sandbox/run-linux/97-s21-settings-lookup/` (Linux filesystem-root case, L97). Each run dir holds `frames-<case>.ndjson`, `cli-debug-<case>.log` (the CLI's own `--debug-file`), `cfg-<case>/` (a fresh `CLAUDE_CONFIG_DIR` per case) and `report.json`. In the evidence, `<B>` is the base of the test tree (Windows: the root of a temporary `subst Q:` drive; Linux: `/tmp/t21`, a tmpfs dir owned by uid 1000).

---

## 0. Summary

Observable: a settings file sets `env.ANTHROPIC_BASE_URL` = `<mock 2>/<tag>`. A request to mock 2 at `/<tag>/v1/messages` proves that file's `env` applied and, when several files define the variable, which one won. The host always set `ANTHROPIC_BASE_URL` = mock 1. All cases ran with `--setting-sources=user,project,local` except the control a3.

| Location (relative to the session cwd) | File | Windows | Linux | Cases |
|---|---|---|---|---|
| (a) cwd | `settings.json` | **loaded** | **loaded** | a1 |
| (a) cwd | `settings.local.json` | **loaded** | **loaded** | a2 |
| (a) cwd, control `--setting-sources=user` | `settings.json` | not loaded | not loaded | a3 |
| (b) git root, cwd 2 levels below | `settings.json` | not loaded | not loaded | b1 |
| (b) git root, cwd 2 levels below | `settings.local.json` | not loaded | **loaded** | b2 |
| (b) git root = cwd | `settings.local.json` | loaded | loaded | b3 |
| (c) non-git parent | both | not loaded | not loaded | c1, c2 |
| (d) ancestor 3 levels up | both | not loaded | not loaded | d1, d2 |
| (d) base root (Windows: drive root `Q:\`) | both | not loaded | not loaded | d3, d4 |
| (d) filesystem root `/` (root-owned) | both | n/a | not loaded | r1 (L97) |
| (d) ancestor above the git root | both | not loaded | not loaded | d5, d6 |
| (e) linked worktree, cwd = worktree; file in the **main** worktree root | `settings.json` | not loaded | not loaded | e1 |
| (e) same | `settings.local.json` | not loaded | **loaded** | e2 |
| (e) cwd = worktree/sub; file in the worktree root | `settings.local.json` | not loaded | not loaded | e3 |
| (e) cwd = worktree/sub; file in the worktree root | `settings.json` | not loaded | not loaded | e4 |
| (e) nested repo, file in the outer repo root, cwd in inner/sub | `settings.local.json` | not loaded | not loaded | e5 |
| (e) same | `settings.json` | not loaded | not loaded | e6 |
| (e) nested repo, file in the inner repo root, cwd in inner/sub | `settings.local.json` | not loaded | **loaded** | e7 |
| `--add-dir` dir | `settings.json` | not applied | not applied (file read) | f1 |
| `--add-dir` dir | `settings.local.json` | not applied | not applied (file read) | f2 |
| ancestor of an `--add-dir` dir | `settings.json` | not applied | not applied | f3 |
| git root of an `--add-dir` dir | `settings.local.json` | not applied | not applied | f4 |

Precedence (same on both OSes unless noted): `--settings` file > `settings.local.json` > `settings.json` (project) > user `settings.json` > host env. On Linux the git-root `settings.local.json` beats the cwd one; on Windows only the cwd one exists. The `--add-dir` files never take part.

**Verdict:**
- Project `settings.json` is read **only from the cwd**.
- `settings.local.json` is read from the cwd and, **on POSIX only**, from the *canonical git root* of the cwd. The canonical root is the nearest enclosing repo root, or the **main worktree root** when the cwd is in a linked worktree.
- No ancestor walk, and no `--add-dir` `env`.
- The D13 ancestor leak (05 §13.1) concerns skills and CLAUDE.md, **not** settings files.

---

## 1. Binaries and infrastructure

- `sha256sum` before use: `claude.exe` `76de74f7…ff06769a`, Linux `claude` `24972e3b…3370d0de`. Both equal 05 §1. The container re-checked its mounted copy (same hash).
- Mocks: `hudhud-mock-api` (127.0.0.1:47311) and `hudhud-mock-api-2` (127.0.0.1:47312). Image `hudhud-mock-api:dev` with the 07 `server.mjs` bind-mounted read-only. Internal network `hudhud-net` for the Linux container.
- The mock answers 404 to prefixed paths (`/<tag>/v1/messages`) after logging them. This ends the turn quickly; the CLI made no retry beyond its normal second attempt.
- Env per case: `lib.mjs` `sandboxEnv`, plus `CLAUDE_CONFIG_DIR` = `<run>/cfg-<case>` (fresh per case), and `NO_PROXY` covering both mocks. The proxy trap is mock 1 (CONNECT refused). Fake key only.
- Argv: `--output-format=stream-json --input-format=stream-json --verbose --permission-mode=default --setting-sources=user,project,local --debug-file=<run>/cli-debug-<case>.log`, plus `--add-dir`/`--settings` where noted.
- Repos were hand-built: `.git/{HEAD,config,objects,refs/heads}`. A linked worktree is laid out as `git worktree add` writes it: `main/.git/worktrees/wt/{HEAD,commondir,gitdir}` plus a `wt/.git` file `gitdir: …`.
  - On both OSes the CLI recognised them. The Windows debug log names the main worktree as the canonical root (`not canonicalizing the consent store to <B>\e1\main`), and the Linux run loaded the main-root file (e2).
  - Git itself is not on the sandbox PATH; the CLI's root detection is filesystem-based (§6).
- Linux layout: the test tree is on tmpfs owned by uid 1000. On a Docker Desktop bind mount the ownership check of §6 would fail and canonicalization would be skipped.
- Linux r1: the host created `/.claude/settings.json` and `/.claude/settings.local.json` as root, with tags `rootfsP` and `rootfsL`. The cwd was `/tmp/t21r/r1/x/y`. `/.claude` was removed right after.

## 2. Q1 — lookup locations

**Evidence** (W136, L96, L97). "Tags" = path prefixes seen by mock 2; "m1" = `/v1/messages` requests to mock 1.

| Case | cwd (rel. to `<B>`) | File placed at | Windows tags / m1 | Linux tags / m1 |
|---|---|---|---|---|
| a1 | `a1` | `a1/.claude/settings.json` | `a1` / 0 | `a1` / 0 |
| a2 | `a2` | `a2/.claude/settings.local.json` | `a2` / 0 | `a2` / 0 |
| a3 | `a3` (`--setting-sources=user`) | `a3/.claude/settings.json` | – / 1 | – / 1 |
| b1 | `b1/repo/sub/deeper` | `b1/repo/.claude/settings.json` | – / 1 | – / 1 |
| b2 | `b2/repo/sub/deeper` | `b2/repo/.claude/settings.local.json` | – / 1 | **`b2` / 0** |
| b3 | `b3/repo` | `b3/repo/.claude/settings.local.json` | `b3` / 0 | `b3` / 0 |
| c1, c2 | `cN/parent/child` | `cN/parent/.claude/…` | – / 1 | – / 1 |
| d1, d2 | `dN/l1/l2/l3` | `dN/.claude/…` | – / 1 | – / 1 |
| d3, d4 | `dN/x/y` | `<B>/.claude/…` (Windows: drive root) | – / 1 | – / 1 |
| r1 | `/tmp/t21r/r1/x/y` | `/.claude/settings.json` + `.local.json` | n/a | – / 1 |
| d5, d6 | `dN/repo/sub` | `dN/.claude/…` (above the git root) | – / 1 | – / 1 |
| e1 | `e1/wt` | `e1/main/.claude/settings.json` | – / 1 | – / 1 |
| e2 | `e2/wt` | `e2/main/.claude/settings.local.json` | – / 1 | **`e2` / 0** |
| e3 | `e3/wt/sub` | `e3/wt/.claude/settings.local.json` | – / 1 | – / 1 |
| e4 | `e4/wt/sub` | `e4/wt/.claude/settings.json` | – / 1 | – / 1 |
| e5 | `e5/outer/inner/sub` | `e5/outer/.claude/settings.local.json` | – / 1 | – / 1 |
| e6 | same | `e6/outer/.claude/settings.json` | – / 1 | – / 1 |
| e7 | `e7/outer/inner/sub` | `e7/outer/inner/.claude/settings.local.json` | – / 1 | **`e7` / 0** |

**Debug-log evidence of the paths read.** The CLI logs `Broken symlink or missing file encountered for settings.json at path: <p>` for every settings path it tries that does not exist, and `Watching for changes in setting files …` for the resolved set. Across all cases the only project-tier paths ever named are:
- `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json`;
- on Linux, `<canonical git root>/.claude/settings.local.json`, e.g. `<B>/b1/repo/.claude/settings.local.json` (b1), `<B>/e1/main/.claude/settings.local.json` (e1, e3, e4) and `<B>/e5/outer/inner/.claude/settings.local.json` (e5, e6).

No ancestor path, drive root or `/` path is ever named.

On Windows, every case with a git root logs instead:
```
[WARN] localSettings: not canonicalizing the consent store to <B>\b2\repo — this platform has no uid semantics to verify directory ownership with, so the store stays at the session cwd (canonicalization is POSIX-only)
```

**Verdict.** VERIFIED on both OSes:
- (a) cwd: both files are loaded.
- (b) git root: `settings.json` is never loaded from the git root. `settings.local.json` is loaded from the git root on Linux, and not on Windows.
- (c) A non-git parent is never read.
- (d) No ancestor is read: not 3 levels up, not above the git root, not the drive root, not `/`.
- (e) Linked worktree, Linux: `settings.local.json` comes from the **main worktree root**. The linked worktree's own root is not read when the cwd is below it (e3); only the cwd file, the "legacy" path, is read. Nested repo: the **innermost** repo root is used, never an outer repo. Windows: cwd only.

## 3. Q2 — `--add-dir`

| Case | `--add-dir` | File | Windows | Linux |
|---|---|---|---|---|
| f1 | `f1/extra` | `extra/.claude/settings.json` | not applied (m1 = 1) | not applied (m1 = 1) |
| f2 | `f2/extra` | `extra/.claude/settings.local.json` | not applied | not applied |
| f3 | `f3/extra/sub` | `extra/.claude/settings.json` (ancestor) | not applied | not applied |
| f4 | `f4/repo/sub` (git) | `repo/.claude/settings.local.json` | not applied | not applied |
| p6 | `p6/extra`, cwd `p6/cwd` | both dirs carry `settings.local.json` | cwd wins (`p6cwd`) | cwd wins (`p6cwd`) |

The Linux debug log shows that the CLI does **read** `<add-dir>/.claude/settings.json` and `settings.local.json`, for example `<B>/q3/extra/.claude/settings.json` in q3 and `<B>/f4/repo/sub/.claude/…` in f4. That is the add-dir directory itself, not its ancestors or git root.

The binary shows what that read is for (§6): only `enabledPlugins` and `extraKnownMarketplaces` are taken from those files, and `env` is not.

**Verdict.** VERIFIED: `env` from `--add-dir` settings never applies, on both OSes.

Residual (outside this guard's scope): an `--add-dir` settings file can enable plugins and register marketplaces. A plugin carries hooks and MCP servers, so this is executable configuration, not credential routing.

## 4. Q3 — precedence

| Case | Files | Winner (both OSes unless noted) |
|---|---|---|
| p1 | cwd `settings.json` (`p1proj`) + cwd `settings.local.json` (`p1local`) | `p1local` |
| p2 | user `cfg/settings.json` (`p2user`) + cwd `settings.json` (`p2proj`) | `p2proj` |
| p3 | user `cfg/settings.json` only (`p3user`) | `p3user` (the user tier also overrides the host env) |
| p4 | git-root `settings.local.json` (`p4root`) + cwd `settings.local.json` (`p4cwd`), cwd = `repo/sub` | **Linux `p4root`, Windows `p4cwd`** (Windows never reads the root file) |
| p5 | `--settings=<file>` (`p5flag`) + cwd `settings.local.json` (`p5local`) | `p5flag` |
| p6 | cwd `settings.local.json` + `--add-dir` `settings.local.json` | cwd (`--add-dir` never applies) |

Host-env versus project: project wins (07 §9 p1, and every "loaded" row above, where the host set mock 1).

Order: host env < user < project `settings.json` < local (on POSIX, canonical root over cwd legacy) < `--settings` < policy. The policy tier was not tested; the binary's order `user < project < local < flag < policy` was read in §6.

## 5. Q4 — `.mcp.json` and CLAUDE.md (recorded only)

| Case | Setup | `.mcp.json` server (system/init `mcp_servers`) | CLAUDE.md marker sent to the API |
|---|---|---|---|
| q1 | both in a non-git parent of the cwd | `t21q1`, `source:"project"`, CLI connected to it (`POST/GET /mcp-q1` on mock 1) | yes |
| q2 | both above the git root (cwd `repo/sub`) | `t21q2` loaded and connected | yes |
| q3 | both in an `--add-dir` dir | not loaded | no |
| q4 | CLAUDE.md in an `--add-dir` dir + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | n/a | yes |

Same on Windows and Linux. **`.mcp.json` and CLAUDE.md follow a different lookup from settings.**
- Both walk **every ancestor**: across the git root and outside any repo.
- `.mcp.json`: the binary's loop stops *before* the filesystem root (§6).
- CLAUDE.md: the debug line `$.fs.ancestors (cc-plugin-agents-md) … found 0 of N directories` counts all ancestors up to, but not including, the root.
- Project `.mcp.json` servers were connected without any approval prompt (consistent with 07 §10).

## 6. Q5 — binary corroboration (strings of the Linux binary, `S/analysis/linux.txt`)

Settings path resolution (identifiers are minified):
```
function Mz(e,n){switch(e){case"userSettings":return Se(Mnn(e,n),k_(n));
  case"projectSettings":case"localSettings":{if(n.cwd===null&&n.projectConfigDir===void 0)return;return Se(Mnn(e,n),kO(e))} ...
function kO(e){switch(e){case"projectSettings":return Se(".claude","settings.json");case"localSettings":return Se(".claude","settings.local.json")}}
function Mnn(e,n){switch(e){ ...
  case"projectSettings":return fe(n.projectConfigDir??Szn(n));                       // cwd (or --project-config-root)
  case"localSettings":{if(n.projectConfigDir!==void 0)return fe(n.projectConfigDir);return kN(Szn(n),n.canonicalGitRoot)} ...
function hse(e){if(e.cwd===null||kN(e.cwd,e.canonicalGitRoot)===fe(e.cwd))return;if(e.projectConfigDir!==void 0)return;
  return Se(fe(e.cwd),kO("localSettings"))}                                            // the "legacy" cwd local file
function Lnn(e,n,{includeLegacyLocalSettings:s=!0}={}){ ... if(e==="localSettings"&&s){let d=hse(n);
  if(d){let{settings:c}=x1(d,n.store);if(c)return ..., T1(c,i||{},UY)}} ...           // legacy merged under the canonical file
```

How `kN` and `jAr` pick the root of `settings.local.json`:
- It is the canonical git root of the cwd. The cwd is kept when:
  - there is no root;
  - the root equals the cwd;
  - the root equals the real home dir;
  - the platform has no `getuid`/`geteuid`, which covers Windows: `canonicalization is POSIX-only`;
  - the root, its `.git` entry or its `.claude` entry is not owned by the current uid (`gFs`).
- The git root comes from a filesystem walk for a `.git` entry (`OCr`, a stat of `<dir>/.git` up the tree). A `.git` *file* is followed to its common dir, which gives the main worktree (`is` → `Jn`). Git itself is not spawned.

`--add-dir` settings (`m4`, `Wcr`):
```
var jcr=["settings.json","settings.local.json"];
function m4(){ ... for(let n of od())for(let r of jcr){let{settings:s}=Uy(Fk(n,".claude",r));if(!s?.enabledPlugins)continue;Object.assign(e,s.enabledPlugins)} ...
function Wcr(){ ... for(let h of e)for(let y of jcr){let{settings:S}=Uy(Fk(h,".claude",y));if(!S?.extraKnownMarketplaces)continue; ...
```

Project `.mcp.json` (`W8t`, case `"project"`):
```
let S=we(),w=Kr()??S;while(w!==FUo(w).root)y.push(w),w=NUo(w);for(let H of y.reverse()){let G=W9(H,".mcp.json") ...
```

Also present:
- A hidden launch flag **`--project-config-root`** (`projectConfigDir`). It replaces the cwd as the root for project and local settings and for `.mcp.json`.
- The schema text `Settings precedence is user < project < local < flag < policy`.

## 7. Design implication — `projectCredentialEnv` guard (W3-T3)

The K5 superset (cwd, every ancestor to the root, every `--add-dir` entry and its ancestors) may be narrowed only by evidence. This spike provides it for 2.1.296 on Windows and Linux:

| Location | Read by the CLI for `env`? | Guard |
|---|---|---|
| `<cwd>/.claude/settings.json` | yes (both OSes) | **scan** |
| `<cwd>/.claude/settings.local.json` | yes (both OSes) | **scan** |
| `<nearest git root of cwd>/.claude/settings.local.json` | yes on POSIX (b2, e7, p4), not on Windows | **scan on all OSes** (cheap; the platform gate and the ownership/home exceptions are CLI internals that may change) |
| `<main worktree root>/.claude/settings.local.json` when the cwd is in a linked worktree (`.git` file → `commondir`) | yes on POSIX (e2) | **scan on all OSes** |
| `settings.json` at the git root / main worktree root | no (b1, e1) | scan anyway: it costs one read and removes a fragile distinction; the evidence permits dropping it |
| `<--project-config-root>/.claude/*` | yes, by the binary, when that flag is given | hudhud never passes the flag; reject it in raw argv passthrough, or scan it if ever allowed |
| ancestors of the cwd (non-git, above the git root, drive root, `/`) | no (c, d, r1) | **may be dropped** |
| outer repos of a nested repo | no (e5, e6) | may be dropped |
| `--add-dir` entries and their ancestors | read, but `env` not applied (f1–f4, p6) | **may be dropped** for this guard; the plugin/marketplace residual (§3) belongs to the plugin posture, not here |

Resulting **guard scan set**:
- `{cwd, gitRoot(cwd), canonicalRoot(cwd)}` × `{settings.json, settings.local.json}`.
- `gitRoot` is the nearest ancestor with a `.git` entry (directory or file).
- `canonicalRoot` resolves a `.git` file through `gitdir` and `commondir` to the main worktree.
- Resolve both with a filesystem walk (no git spawn), on every OS.

Conditions on keeping the narrowed set:
1. It is tied to the tested version window. The canary (K16) re-runs `t21-settings-lookup.mjs` on the newest version, and any new location fails it.
2. If git-root resolution fails (unreadable `.git` file, symlinked `.git`), the guard falls back to the K5 superset and records that in `details` (fail closed).
3. The D13 wording in ADR-0012 §2 and plan §1.8 ("ancestors are read") should be corrected for settings files. D13 holds for skills, CLAUDE.md and `.mcp.json`, not for settings.

## 8. Not done / limits

- macOS: no host. The POSIX branch (git-root canonicalization) is expected statically, not verified.
- Policy/managed tier precedence: not exercised.
- Linux ownership fallback (repo not owned by the uid) and the home-equals-git-root exception: read from the binary only. Both narrow loading, so neither can widen the guard set.
- Symlinked `.claude` or settings files: not exercised. The binary tracks `linkedAway` and watches symlink targets.
- Submodules (`.git` file without `commondir`): not exercised.

## 9. Cleanup and isolation evidence

- **Processes.** After the runs, `Get-CimInstance Win32_Process` filtered on command lines containing the sandbox path returned **none**, and the `sleep.exe` count was 0. The only `claude.exe` processes on the host were the user's own sessions; they were not touched. In the Linux container before removal, `/proc` listed only `docker-init`, `sleep infinity` and the listing shell.
- **Aborted run W135.** The first full Windows invocation hit the tool's 590 s timeout. A driver bug waited 30 s for `system/init` before sending the user message. The driver process was killed, so W135 has no `report.json`. Its `subst Q:` mapping survived and was removed by hand (`subst Q: /D`). Immediately afterwards a process sweep on the run path found no survivors. The bug was fixed and the full run repeated as W136. W134 was a one-case trial.
- **Drive mapping.** `subst` lists nothing and `Q:\` does not exist (checked after the last run). `substRemoved: true` in W134 and W136.
- **Containers / network.** Removed: `hudhud-cli-linux`, `hudhud-mock-api`, `hudhud-mock-api-2`, network `hudhud-net`. Afterwards `docker ps -a --filter name=hudhud` and `docker network ls --filter name=hudhud` are empty. Kept: image `hudhud-mock-api:dev` (`cd0ea2b23775`, unchanged) and volume `hudhud-pnpm-store` (untouched). No other container was touched.
- **Writes outside the run dirs.**
  - Windows: `report.outsideChanges` was empty for W134 and W136. This time even the profile-root `.claude.json` mtime did not change.
  - Linux: the only entries were `/tmp/t21`, `/tmp/t21r` (the test trees) and `/tmp/cc-socks-1000` (known, 05 §13), all on the container's tmpfs and deleted with it. `/home/node` stayed empty, and `/.claude` was removed after r1.
- **Egress.** All model traffic went to mock 1 or mock 2. The only other requests were the q1/q2 project MCP servers' `POST/GET /mcp-qN`, sent to mock 1 by design. Only the fake key was sent.
- **Real install / real config.** Never executed or read: no `~/.claude`, `~/.claude.json` or `%APPDATA%`. Only the pinned binaries under `S/sandbox/bin` were run. `S/dl` was not used. The hudhud git repo was not modified.

## 10. Reproducing

```
docker network create --internal hudhud-net
docker run -d --name hudhud-mock-api   -p 127.0.0.1:47311:8080 -v <S>\sandbox\mock-api\logs:/logs  -v <S>\sandbox\mock-api\server.mjs:/app/server.mjs:ro --user root hudhud-mock-api:dev
docker run -d --name hudhud-mock-api-2 -p 127.0.0.1:47312:8080 -v <S>\sandbox\mock-api\logs2:/logs -v <S>\sandbox\mock-api\server.mjs:/app/server.mjs:ro --user root hudhud-mock-api:dev
for c in hudhud-mock-api hudhud-mock-api-2; do docker network connect --alias $c hudhud-net $c; done
cd S/sandbox/driver && node t21-settings-lookup.mjs            # Windows (needs Q: free)
docker run -d --init --name hudhud-cli-linux --network hudhud-net --user node --tmpfs /tmp:rw,exec,size=256m --tmpfs /home/node:rw,size=64m \
  -v <S>\sandbox\bin\linux-x64\x\package:/sandbox/bin/linux-x64/x/package:ro -v <S>\sandbox\driver:/sandbox/driver:ro -v <S>\sandbox\run-linux:/sandbox/run-linux \
  -e HUDHUD_MOCK_URL=http://hudhud-mock-api:8080 -e HUDHUD_MOCK2_URL=http://hudhud-mock-api-2:8080 -e HOME=/home/node node:24-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec -e HUDHUD_T21_BASE=/tmp/t21 -w /sandbox/driver hudhud-cli-linux node t21-settings-lookup.mjs
# filesystem-root case: as root create /.claude/settings{,.local}.json (tags rootfsP/rootfsL), then
MSYS_NO_PATHCONV=1 docker exec -e HUDHUD_T21_BASE=/tmp/t21r -w /sandbox/driver hudhud-cli-linux node t21-settings-lookup.mjs rootfs
```
Run Windows and Linux sequentially, because mock attribution is by sequence window.
