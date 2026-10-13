// A sandbox environment as the recorder's sandbox builds it, for a given
// platform, with fixed directories: the parent the product's environment
// builder filters when the recorder launches a case (W4-T2 single source).

import { buildSandboxEnv } from '../../../../tooling/test-support/src/launcher/env.js';
import type {
  SandboxCredential,
  SandboxDirs,
} from '../../../../tooling/test-support/src/launcher/env.js';

/** The sandbox directories of a platform (any fixed absolute paths). */
export function sandboxDirs(platform: 'linux' | 'win32'): SandboxDirs {
  const root = platform === 'win32' ? 'R:\\hudhud-run' : '/r/hudhud-run';
  const join = (...parts: string[]): string =>
    [root, ...parts].join(platform === 'win32' ? '\\' : '/');
  return {
    root,
    cfg: join('cfg'),
    home: join('home'),
    appData: join('home', 'AppData', 'Roaming'),
    localAppData: join('home', 'AppData', 'Local'),
    tmp: join('tmp'),
    work: join('work'),
  };
}

/** The sandbox environment of a platform. */
export function sandboxParent(
  platform: 'linux' | 'win32',
  credential: SandboxCredential = 'api-key',
): Readonly<Record<string, string>> {
  return buildSandboxEnv({
    platform,
    dirs: sandboxDirs(platform),
    mockUrl: 'http://127.0.0.1:41000',
    hostEnv: {},
    gitBashPath: platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : undefined,
    credential,
  });
}
