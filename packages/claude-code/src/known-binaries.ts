/**
 * The committed provenance table of the Claude Code binaries in the tested
 * window (K8, ADR-0011, plan §1.8): the one source of the digest table and of
 * the pinned publisher.
 *
 * @remarks
 * - Digests: version, then platform (`<process.platform>-<process.arch>`),
 *   then the sha256 and size of the native binary, for every version of the
 *   tested window (ADR-0004 §4, rolling-window amendment of 2026-10-18).
 *   Each version's values are what `pnpm cli:bump <version> --sdk <sdk>`
 *   recorded: the registry's `dist.integrity` of the platform tarball, the
 *   tarball verified against it, and the extracted binary's sha256 and size
 *   required to equal the `manifest.json` of the Agent SDK release that
 *   bundles the same CLI version (research 05 §1); a unit test keeps the
 *   pinned version's entry equal to `tooling/cli-pin.json` and every version
 *   inside the window. Changed only by the version-bump PR the lead prepares
 *   locally (K16).
 * - 2.1.296: darwin-arm64 and darwin-x64 recorded by the macOS gate (M1) on
 *   both runners, each cross-checked against the npm integrity and the
 *   `manifest.json` of `@anthropic-ai/claude-agent-sdk@0.3.296` (research 10
 *   §5), and verified against the pin by gate item 1 (research 11).
 * - 2.1.299, 2.1.300, 2.1.301 and 2.1.302 (COMPAT-1, 2026-10-18): every
 *   platform recorded by `pnpm cli:bump` against the Agent SDK releases
 *   0.3.299, 0.3.300, 0.3.301 and 0.3.302 (each states the CLI version it
 *   bundles in `claudeCodeVersion`). The win32-x64 binaries of all four carry
 *   the same Authenticode signer subject and leaf certificate as 2.1.296
 *   (read with `Get-AuthenticodeSignature`, never executed). The macOS
 *   gate's item 1 checks the pin's darwin binaries (2.1.302) against this
 *   table and the Team ID on every gate run; the darwin binaries of the
 *   three versions in between rest on the two digest sources, and strict
 *   mode checks their signature against the Team ID when they run.
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
      'darwin-arm64': Object.freeze({
        sha256: 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937',
        size: 240664432,
      }),
      'darwin-x64': Object.freeze({
        sha256: 'a6bf4f30be241053a923f3820ad23c5991d2f5ac2935b3a8dd64da218d9cc603',
        size: 249194752,
      }),
    }),
    '2.1.299': Object.freeze({
      'linux-x64': Object.freeze({
        sha256: '2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077',
        size: 265342136,
      }),
      'win32-x64': Object.freeze({
        sha256: '295b49ec092f31a7de9c6ff286d9d8f120a4f029b9ad9a5ac0b12c35cbf4df2b',
        size: 269231264,
      }),
      'darwin-arm64': Object.freeze({
        sha256: 'ba5ab7b8c195fa03ab8d5bf3915c76153b576a2c40e79a5c46e265e7ed9744b3',
        size: 247931696,
      }),
      'darwin-x64': Object.freeze({
        sha256: '099dcc53dabbbefabed8926dab25b0318775c175a7c87bb6ba6c54fde9f8ece2',
        size: 257765072,
      }),
    }),
    '2.1.300': Object.freeze({
      'linux-x64': Object.freeze({
        sha256: '674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453',
        size: 266972344,
      }),
      'win32-x64': Object.freeze({
        sha256: '56810a111c01dcd218b42727c23fd8763be42320038b1adcac93cf599fac2de2',
        size: 270863520,
      }),
      'darwin-arm64': Object.freeze({
        sha256: '475517caa611e3318a2f298fa071287ec98955538df78c58f709ecc01e5ae2d3',
        size: 249556880,
      }),
      'darwin-x64': Object.freeze({
        sha256: '5824fc36863e70bbd070491bb9359e217d3f17b38c45697c085b31a3a67356b3',
        size: 259416272,
      }),
    }),
    '2.1.301': Object.freeze({
      'linux-x64': Object.freeze({
        sha256: 'bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222',
        size: 267955384,
      }),
      'win32-x64': Object.freeze({
        sha256: '84d61feeb1a07e5a5b3354d68432591cac18a5d38a419a30d86d0f3ad8cba397',
        size: 271840416,
      }),
      'darwin-arm64': Object.freeze({
        sha256: '1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99',
        size: 250541840,
      }),
      'darwin-x64': Object.freeze({
        sha256: '3439427bfce962fddcf557c5a058ca914fa63e06fee894f8e12a3f10e04d1871',
        size: 260406992,
      }),
    }),
    '2.1.302': Object.freeze({
      'linux-x64': Object.freeze({
        sha256: '60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5',
        size: 285793528,
      }),
      'win32-x64': Object.freeze({
        sha256: '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae',
        size: 290211488,
      }),
      'darwin-arm64': Object.freeze({
        sha256: '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37',
        size: 267956720,
      }),
      'darwin-x64': Object.freeze({
        sha256: 'b9a913114f42870ec8e38848c88c855d73f73187871ec2e1ad05bbe54029d9ac',
        size: 279242736,
      }),
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
