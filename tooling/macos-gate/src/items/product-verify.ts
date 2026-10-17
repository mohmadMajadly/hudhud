/**
 * Gate item 1, part 2: the product's own binary verification on the real
 * darwin binary (research 11).
 *
 * The codesign checks of `provenance.ts` show what macOS reports. These
 * checks run the code a hudhud user runs, with the committed pins:
 *
 * - the core macOS signature check (`checkOsSignature`) with
 *   `CLAUDE_CODE_PUBLISHER`, whose Team ID codesign must accept in its
 *   Developer ID requirement;
 * - the same check with another well-formed Team ID: codesign must evaluate
 *   the requirement and refuse it (exit 3, "requirement not satisfied"),
 *   which proves that the requirement is parsed and decides the verdict
 *   rather than being ignored (exit 1 would mean no valid signature at all);
 * - `verifyBinary` in strict and advisory mode with the adapter's digest
 *   table for this platform (`knownDigestsFor`), which must report
 *   `verified` for the pinned version.
 */

import { resolveExecutable } from '../../../../packages/core/src/process/binary-path.js';
import {
  checkOsSignature,
  type PublisherPin,
  type SignatureDeps,
} from '../../../../packages/core/src/process/verify/os-signature.js';
import {
  verifyBinary,
  type VerificationMode,
} from '../../../../packages/core/src/process/verify/verify.js';
import {
  CLAUDE_CODE_PUBLISHER,
  knownDigestsFor,
} from '../../../../packages/claude-code/src/provenance.js';
import type { ProductSeams } from '../host.js';
import type { ItemRecorder } from '../report.js';
import { errorMessage } from './common.js';

/** A well-formed Team ID that is not the pinned one: the negative control. */
export const CONTROL_TEAM_ID = 'AAAAAAAAAA';

/** The modes `verifyBinary` is run in, strict first (the one that runs codesign). */
const MODES: readonly VerificationMode[] = ['strict', 'advisory'];

/**
 * Runs the product's verification of `binary` (this runner's pinned darwin
 * binary, `platformKey` `darwin-arm64` or `darwin-x64`) and records one
 * check per expectation.
 */
export async function productVerification(
  seams: ProductSeams,
  binary: string,
  platformKey: string,
  version: string,
  r: ItemRecorder,
): Promise<void> {
  const signatureDeps = (publisher: PublisherPin): SignatureDeps => ({
    platform: 'darwin',
    hostEnv: {},
    ...seams.signature,
    publisher,
  });

  const pinned = await checkOsSignature(binary, signatureDeps(CLAUDE_CODE_PUBLISHER));
  r.note('productSignature', pinned);
  r.check(
    `product: the codesign requirement with the pinned Team ID ${CLAUDE_CODE_PUBLISHER.darwinTeamId} passes`,
    pinned.kind === 'valid',
    JSON.stringify(pinned),
  );

  const control = await checkOsSignature(binary, signatureDeps({ darwinTeamId: CONTROL_TEAM_ID }));
  r.note('productSignatureControl', control);
  r.check(
    `product: the same requirement with Team ID ${CONTROL_TEAM_ID} is evaluated and refused (codesign exit 3)`,
    control.kind === 'invalid' && control.detail === 'codesign failed: exit 3',
    JSON.stringify(control),
  );

  const digests = knownDigestsFor(platformKey);
  r.check(
    `product: the committed digest table has ${platformKey} ${version}`,
    digests.some((entry) => entry.version === version),
    JSON.stringify(digests),
  );
  const verdicts: Record<string, unknown> = {};
  for (const mode of MODES) {
    let ok = false;
    let detail: string;
    try {
      const resolved = await resolveExecutable(binary, {
        platform: 'posix',
        ...(seams.executableFs === undefined ? {} : { fs: seams.executableFs }),
      });
      const verified = await verifyBinary(resolved, {
        mode,
        digests,
        platform: 'darwin',
        publisher: CLAUDE_CODE_PUBLISHER,
        hostEnv: {},
        deps: { ...seams.verify, signature: seams.signature },
      });
      verdicts[mode] = {
        verification: verified.verification,
        matchedVersion: verified.matchedVersion,
        sha256: verified.sha256,
        size: verified.size,
      };
      ok = verified.verification.status === 'verified' && verified.matchedVersion === version;
      detail = `${verified.verification.status}: ${String(verified.verification.detail)}`;
    } catch (error) {
      detail = errorMessage(error);
      verdicts[mode] = { error: detail };
    }
    r.check(`product: verifyBinary (${mode}) reports verified ${version}`, ok, detail);
  }
  r.note('productVerification', verdicts);
}
