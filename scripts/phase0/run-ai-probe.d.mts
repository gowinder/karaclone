/** phase0 run-ai-probe 的类型声明（脚本为 ESM 运行时代码）。 */

export interface RunAiProbeOptions {
  deployPath: string;
  apiKey: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  checkedAt?: string;
}

export interface AiArtifact {
  profile: string;
  deploymentId: string;
  versionIds: string[];
  workerUrl: string;
  sourceDeploySha256: string;
  checks: Record<string, unknown>;
  model: string | null;
  tags: string[];
  description: string | null;
  http1102Count: number;
  error?: string;
  checkedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
}

export function runAiProbe(options: RunAiProbeOptions): Promise<AiArtifact>;

export function main(argv: string[]): Promise<void>;
