export const EXTENSION_LOCK: Readonly<{
  extensionId: string;
  version: string;
  publisher: string;
  storeUrl: string;
  prodversion: string;
  updateUrl: string;
  redirectHostAllowList: string[];
  storeEvidenceFile: string;
}>;

export type ExtensionManifest = {
  lockStatus: string;
  client: string;
  platform: string;
  version: string;
  build: null;
  packageId: string;
  packageSha256: string;
  packageSize: number;
  verificationProjection: unknown;
  verificationProjectionSha256: string | null;
  canonicalSha256: string | null;
  passed: boolean;
  observations: { signerPublicKeySha256: string; finalUrl: string };
  storeEvidenceSha256: string;
  extensionId: string;
};

export function deriveExtensionId(publicKeyDer: Uint8Array): string;
export function parseCrx3(
  bytes: Uint8Array,
): { blocks: Array<{ algorithm: string; publicKey: Uint8Array; signature: Uint8Array }>; signedHeaderData: Uint8Array | null; zipBytes: Uint8Array };
export function verifyCrxProof(bytes: Uint8Array): { verified: boolean; algorithm: string; publicKey: Uint8Array; publicKeySha256: string };
export function buildUpdateRequest(constants: typeof EXTENSION_LOCK): string;
export function verifyExtensionPackage(opts?: {
  fetchImpl?: (url: string) => Promise<{ status: number; headers?: Headers; body: Uint8Array }>;
  constants?: typeof EXTENSION_LOCK;
  storeEvidence?: Record<string, unknown>;
  evidenceDir?: string;
  version?: string;
}): Promise<ExtensionManifest>;
export function main(argv: string[]): Promise<void>;
