/** phase0 replay-final-store 的类型声明（脚本为 ESM 运行时代码）。 */

export interface ContentManifest {
  exclusionRulesVersion: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  canonicalSha256: string;
}

export function buildContentManifest(dir: string, exclusionRulesVersion: string): Promise<ContentManifest>;

export interface CrxDownload {
  requestUrl?: string | null;
  redirectChain?: string[];
  body: Buffer | Uint8Array;
}

export interface CrxProof {
  algorithm: string;
  publicKey: Buffer;
  publicKeySha256: string;
  crxIdHex?: string | null;
}

export interface CdpSession {
  getExtensionInfo(): Promise<{ id: string; version: string; source: string }>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface CdpLike {
  connect(args: { cdpPort: number; profileDir: string }): Promise<CdpSession>;
}

export interface ReplayOptions {
  artifactsDir?: string;
  profileDir: string;
  profileSessionNonce: string;
  cdpPort: number;
  expectedSessionNonce?: string;
  fetchImpl?: () => Promise<CrxDownload>;
  cdp?: CdpLike | ((args: { cdpPort: number; profileDir: string }) => Promise<CdpSession>);
  unzip?: (crxPath: string, outDir: string) => Promise<void>;
  findExtensionDir?: (profileDir: string) => Promise<string>;
  verifyCrx?: (bytes: Buffer) => CrxProof;
  expectedPackageSha256?: string;
  clientLockPath?: string;
  storeEvidencePath?: string;
  contentBindingPath?: string;
  deployProvenancePath?: string;
  reviewedBy?: string;
  checkedAt?: string;
}

export interface ReplayResult {
  passed: boolean;
  binding: Record<string, unknown>;
  installedManifest: ContentManifest;
  signedManifest: ContentManifest;
  screenshotManifest: Record<string, unknown>;
  screenshotSha256: string;
}

export function runReplay(options: ReplayOptions): Promise<ReplayResult>;

export function main(argv: string[]): Promise<void>;
