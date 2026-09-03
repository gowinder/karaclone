/** phase0 remote-contract 的类型声明（脚本为 ESM 运行时代码）。 */

import type { SpawnFn } from "./remote-common.d.mts";

export interface RunContractOptions {
  deployPath: string;
  apiKey: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: SpawnFn;
  checkedAt?: string;
}

export interface ContractArtifact {
  profile: string;
  deploymentId: string;
  versionIds: string[];
  workerUrl: string;
  sourceDeploySha256: string;
  checks: Record<string, unknown>;
  requestCount: number;
  http1102Count: number;
  error?: string;
  checkedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
}

export function runContract(options: RunContractOptions): Promise<ContractArtifact>;

export function main(argv: string[]): Promise<void>;
