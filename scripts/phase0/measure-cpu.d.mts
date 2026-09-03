/** phase0 measure-cpu 的类型声明（脚本为 ESM 运行时代码）。 */

import type { SpawnFn } from "./remote-common.d.mts";

export interface CpuRow {
  requests: number;
  errors: number;
  cpuTimeP50: number;
  cpuTimeP99: number;
}

export interface RunCpuOptions {
  deployPath: string;
  graphql: () => Promise<CpuRow[] | { rows: CpuRow[] }>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: SpawnFn;
  apiKey?: string;
  accountId?: string;
  analyticsToken?: string;
  checkedAt?: string;
}

export interface CpuArtifact {
  profile: string;
  deploymentId: string;
  versionIds: string[];
  workerUrl: string;
  sourceDeploySha256: string;
  checks: Record<string, unknown>;
  requestCounts: Record<string, number>;
  http1102Count: number;
  graphql: { totalRequests: number; totalErrors: number; maxCpuTimeP99Us: number; rows: CpuRow[] };
  reason: string | null;
  error?: string;
  checkedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
}

export function runCpu(options: RunCpuOptions): Promise<CpuArtifact>;

export function defaultGraphql(options: {
  accountId: string;
  analyticsToken: string;
  from: string;
  to: string;
  scriptName: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<CpuRow[]>;

export function telemetryQuery(options: {
  token: string;
  accountId: string;
  versionId: string;
  eventType: string;
  from: string;
  to: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{
  versionId: string;
  eventType: string;
  from: string;
  to: string;
  totalCount: number;
  uniqueCount: number;
  eventIds: string[];
  pageCount: number;
  pages: unknown[];
  stable: boolean;
  queryProjection: unknown;
}>;

export function main(argv: string[]): Promise<void>;
