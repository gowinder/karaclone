/** phase0 verify-remote-artifacts 的类型声明（脚本为 ESM 运行时代码）。 */

export interface VerifyOptions {
  regularOnly?: boolean;
  artifactsDir?: string;
  deployProbesPath?: string;
  deployCpuPath?: string;
  remoteContractPath?: string;
  aiPath?: string;
  queuePath?: string;
  cpuInvocationRunPath?: string;
  queueInvocationsPath?: string;
  cpuPath?: string;
  freeLimitPath?: string;
  deployCleanupPath?: string;
  checkedAt?: string;
}

export interface VerifyArtifact {
  regularOnly: boolean;
  checks: { artifactCount: number; failures: string[] };
  passed: boolean;
  checkedAt: string;
  canonicalSha256: string | null;
}

export function verifyArtifacts(options?: VerifyOptions): Promise<VerifyArtifact>;

export function main(argv: string[]): Promise<void>;
