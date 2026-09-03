/** phase0 build-content-binding 的类型声明（脚本为 ESM 运行时代码）。 */

export interface ContentManifest {
  contentExclusionRulesVersion: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  canonicalSha256: string;
}

export function buildContentManifest(dir: string, contentExclusionRulesVersion: string): Promise<ContentManifest>;

export interface ContentBindingOptions {
  deployPath?: string;
  extensionManifestPath?: string;
  storeEvidencePath?: string;
  installedDir: string;
  signedDir: string;
  installPngPath?: string;
  profilePath: string;
  profileSessionNonce: string;
  outPath?: string;
  contentExclusionRulesVersion?: string;
  reviewedBy?: string;
  checkedAt?: string;
}

export interface ContentBinding {
  deploymentId: string;
  versionIds: string[];
  profile: string;
  workerUrl: string;
  sourceDeploySha256: string;
  extensionManifestSha256: string;
  installedManifestSha256: string;
  signedManifestSha256: string;
  contentExclusionRulesVersion: string;
  storeEvidenceSha256: string;
  installScreenshotSha256: string;
  profilePathHash: string;
  profileSessionNonce: string;
  capturedAt: string;
  reviewedBy: string;
  reviewedAt: string;
  canonicalSha256: string;
  passed: boolean;
}

export function buildContentBinding(options: ContentBindingOptions): Promise<ContentBinding>;

export function main(argv: string[]): Promise<void>;
