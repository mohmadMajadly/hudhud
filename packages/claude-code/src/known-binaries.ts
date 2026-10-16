/**
 * The committed provenance table of the Claude Code binaries in the tested
 * window (K8, ADR-0011, plan §1.8): the one source of the digest table and of
 * the pinned publisher.
 *
 * @remarks
 * - Digests: version, then platform (`<process.platform>-<process.arch>`),
 *   then the sha256 and size of the native binary. Values from
 *   `tooling/cli-pin.json` (npm integrity and `manifest.json` cross-checked,
 *   research 05 §1); a unit test keeps this table equal to the pin for every
 *   pinned platform. Changed only by the version-bump PR the lead prepares
 *   locally (K16).
 * - darwin-arm64 and darwin-x64 are left out on purpose until the macOS gate
 *   (M1) has recorded and cross-checked their digests; until then a darwin
 *   binary is `unverified` in advisory mode and refused in strict mode unless
 *   the application supplies `claudeCode.binaryDigests`.
 * - Publisher (W3-Z ruling 9): strict mode requires the Authenticode signer
 *   subject below on Windows, read-only from the pinned win32-x64 2.1.296
 *   binary with `Get-AuthenticodeSignature` (the binary was never executed).
 *   Recorded with it as evidence, not required (see `os-signature.ts` in the
 *   core for why the subject and not the thumbprint is pinned): leaf
 *   thumbprint `60C2D9C51F09822FFF4F194DE9EEDB67451292D1` (valid 2026-10-08
 *   to 2027-10-29), issuer `CN=DigiCert Trusted G4 Code Signing RSA4096
 *   SHA384 2021 CA1, O="DigiCert, Inc.", C=US` (thumbprint
 *   `7B0F360B775F76C94A12CA48445AA2D2A875701C`), root `DigiCert Trusted Root
 *   G4` (thumbprint `DDFB16CD4931C973A2037D3FC83A4D7D775D05E4`), timestamped
 *   by `DigiCert SHA256 RSA4096 Timestamp Responder 2026 1`. macOS: strict
 *   mode requires the Team ID below in a Developer ID signature (the core's
 *   `codesignRequirement`). Recorded by `codesign -dv` on both darwin
 *   binaries of 2.1.296 in macOS gate run 2 (research 10 §5):
 *   `Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`,
 *   `Developer ID Certification Authority`, `Apple Root CA`,
 *   `TeamIdentifier=Q6L2SF6YDW`, `Identifier=com.anthropic.claude-code`.
 *   Gate item 1 runs the product's check with this pin on every gate run.
 *
 * Nothing here is fetched at run time.
 *
 * @packageDocumentation
 */

/**
 * One digest entry of the committed table.
 *
 * @internal
 */
export interface KnownBinaryDigest {
  readonly sha256: string;
  readonly size: number;
}

/**
 * The committed digest table: version, then platform key, then the binary's
 * sha256 and size.
 *
 * @internal
 */
export const KNOWN_BINARIES: Readonly<Record<string, Readonly<Record<string, KnownBinaryDigest>>>> =
  Object.freeze({
    '2.1.296': Object.freeze({
      'linux-x64': Object.freeze({
        sha256: '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de',
        size: 257068216,
      }),
      'win32-x64': Object.freeze({
        sha256: '76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a',
        size: 260489376,
      }),
      // darwin-arm64, darwin-x64: added only after the macOS gate (M1).
    }),
  });

/**
 * The publisher strict verification requires of the Claude Code binary
 * (the core's `PublisherPin`).
 *
 * @internal
 */
export const CLAUDE_CODE_PUBLISHER: {
  readonly windowsSubject: string;
  readonly darwinTeamId: string;
} = Object.freeze({
  windowsSubject:
    'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US, ' +
    'SERIALNUMBER=4860621, OID.2.5.4.15=Private Organization, ' +
    'OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US',
  darwinTeamId: 'Q6L2SF6YDW',
});
