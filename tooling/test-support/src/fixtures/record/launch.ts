/**
 * The launch of a recorded case, built by the product (lead ruling, W4-T2):
 * the CLI's argv and environment come from the adapter's own builders
 * (`resolveConnectSessionOptions`, `buildArgv`, `buildChildEnv` of
 * `@hudhudjs/claude-code`, plan §2.3-§2.5), never from a copy kept here.
 *
 * @remarks
 * Layering: test-support may not depend on `@hudhudjs/claude-code` (the
 * adapter already dev-depends on test-support, and its builders are not
 * public). The builders are therefore injected: {@link productLaunchBuilder}
 * takes them as a {@link ProductLaunchApi} and the composition root that
 * imports them lives in the adapter's test tree
 * (`packages/claude-code/test/record/`), which may import both.
 *
 * What a case may vary is product input only: hudhud session options
 * (`claudeCode.includePartialMessages`, `claudeCode.maxTurns`, `env.add`,
 * ...), whether a permission handler is registered, and how the session
 * starts (create, resume, fork). The test-only parts are the parent
 * environment the product filters (the sandbox: redirected home, config
 * and temp directories, the fake credential, the mock as base URL and as
 * the egress-trap proxy) and `claudeCode.configDir` set to the sandbox
 * config directory. Nothing is added to the product's output.
 */

import { isJsonObject, type JsonObject } from '@hudhudjs/core/protocol';

/** How a case starts its session (the product's `LaunchSpec`). */
export type CaseStart =
  | { readonly mode: 'create'; readonly sessionId: string }
  | { readonly mode: 'resume'; readonly resumeId: string }
  | { readonly mode: 'fork'; readonly resumeId: string; readonly sessionId: string };

/** The product input of one recorded case. */
export interface CaseLaunch {
  readonly start: CaseStart;
  /** hudhud `session()` options of the case (plan §2.3), on top of the defaults. */
  readonly options?: JsonObject;
  /** A permission handler is registered: the product passes `--permission-prompt-tool=stdio`. */
  readonly permissionHandler?: boolean;
}

/** What {@link LaunchBuilder} needs besides the case. */
export interface LaunchRequest {
  readonly launch: CaseLaunch;
  /** The sandbox config directory, passed as `claudeCode.configDir`. */
  readonly configDir: string;
  /** The environment the product filters as its parent: the sandbox's. */
  readonly parentEnv: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}

/** The product's launch of a case. */
export interface BuiltLaunch {
  /** The argv after the binary, as `buildArgv` returns it. */
  readonly argv: readonly string[];
  /** The environment, as `buildChildEnv` returns it (before the spawn layer's blanks). */
  readonly env: Readonly<Record<string, string>>;
}

/** Builds the launch of a case. */
export type LaunchBuilder = (request: LaunchRequest) => BuiltLaunch;

/**
 * The adapter builders, typed structurally so that both the sources (the
 * parity test) and the built modules (the recorder's composition root)
 * satisfy it.
 */
export interface ProductLaunchApi<Connect, Session> {
  readonly resolveConnectSessionOptions: (input: unknown) => {
    readonly connect: Connect;
    readonly session: Session;
  };
  readonly buildArgv: (connect: Connect, session: Session, launch: CaseStart) => string[];
  readonly buildChildEnv: (
    session: Session,
    connect: Connect,
    parent: Readonly<Record<string, string | undefined>>,
    platform: 'win32' | 'posix',
  ) => { readonly env: Readonly<Record<string, string>> };
}

/** The permission handler of a case: never called (the recorder answers on the wire). */
function recorderHandler(): never {
  throw new Error('the recorder answers permission requests on the wire');
}

/**
 * The hudhud options of a case: its own options, `claudeCode.configDir` set
 * to the sandbox's config directory and, with a permission handler, the
 * host value that makes the product pass `--permission-prompt-tool=stdio`.
 */
export function caseOptions(request: LaunchRequest): Record<string, unknown> {
  const own = request.launch.options ?? {};
  const claudeCode = own['claudeCode'];
  return {
    ...own,
    claudeCode: {
      ...(isJsonObject(claudeCode) ? claudeCode : {}),
      configDir: request.configDir,
    },
    ...(request.launch.permissionHandler === true ? { onPermission: recorderHandler } : {}),
  };
}

/** The {@link LaunchBuilder} over the product's builders. */
export function productLaunchBuilder<Connect, Session>(
  api: ProductLaunchApi<Connect, Session>,
): LaunchBuilder {
  return (request) => {
    const { connect, session } = api.resolveConnectSessionOptions(caseOptions(request));
    return {
      argv: api.buildArgv(connect, session, request.launch.start),
      env: api.buildChildEnv(
        session,
        connect,
        request.parentEnv,
        request.platform === 'win32' ? 'win32' : 'posix',
      ).env,
    };
  };
}
