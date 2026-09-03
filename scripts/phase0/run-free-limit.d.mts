/** phase0 run-free-limit 的类型声明（脚本为 ESM 运行时代码）。 */

export interface Handoff {
  secret: string;
  pathSegment: string;
  sessionNonce: string;
}

export interface RunFreeLimitOptions {
  deployPath: string;
  cpuRunPath: string;
  queueInvocationsPath: string;
  cpuPath: string;
  cleanupOut: string;
  out: string;
  handoffPath?: string;
  cleanup?: (argv: string[]) => Promise<{ passed: boolean; deploymentId?: string; versionIds?: string[]; error?: string }>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  telemetry?: () => Promise<{ events: Array<{ outcome?: string }> }>;
  checkedAt?: string;
}

export interface FreeLimitArtifact {
  profile: string;
  deploymentId: string;
  versionIds: string[];
  workerUrl: string;
  sourceDeploySha256: string;
  runId: string | null;
  window: { from: string; to: string } | null;
  secretSha256: string | null;
  pathSegmentSha256: string | null;
  handoffSessionNonceSha256: string | null;
  nonceSha256: string | null;
  nonceConsumed: boolean;
  http1102Seen: boolean;
  telemetryExceededCpuSeen: boolean;
  windowsNonOverlapping: boolean;
  probePassed: boolean;
  cleanupCalledByFinally: boolean;
  cleanupResult: unknown;
  error?: string;
  checkedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
}

export function readHandoff(handoffPath: string): Handoff;

export function runFreeLimit(options: RunFreeLimitOptions): Promise<FreeLimitArtifact>;

export function main(argv: string[]): Promise<void>;
