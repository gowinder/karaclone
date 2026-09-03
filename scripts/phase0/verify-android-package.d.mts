export const ANDROID_LOCK: Readonly<{
  versionName: string;
  versionCode: number;
  url: string;
  assetId: number;
  size: number;
  packageId: string;
  packageSha256: string;
  sourceRepository: string;
  sourceTag: string;
  sourceCommit: string;
  signingCertificateSha256: string;
}>;

export type AndroidManifest = {
  lockStatus: string;
  client: string;
  platform: string;
  version: string;
  build: string;
  packageId: string;
  packageSha256: string;
  packageSize: number;
  immutableSourceUrl: string;
  finalUrl: string;
  assetId: number;
  sourceRepository: string;
  sourceTag: string;
  sourceCommit: string;
  signingCertificateSha256: string;
  signerAllowList: string[];
  verifierVersions: Record<string, string>;
  verificationProjection: unknown;
  verificationProjectionSha256: string | null;
  canonicalSha256: string | null;
  passed: boolean;
};

export function redactToolOutput(text: string): string;
export function verifyAndroidPackage(opts?: {
  fetchImpl?: (url: string) => Promise<{ status: number; finalUrl?: string; body: Uint8Array }>;
  runTool?: (tool: string, args: string[]) => { status: number; stdout: string; stderr: string };
  constants?: typeof ANDROID_LOCK;
  version?: string;
}): Promise<AndroidManifest>;
export function writeArtifactJson(path: string, obj: unknown): Promise<void>;
export function main(argv: string[]): Promise<void>;
