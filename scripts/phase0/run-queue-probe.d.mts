/** phase0 run-queue-probe 的类型声明（脚本为 ESM 运行时代码）。 */

import type { SpawnFn } from "./remote-common.d.mts";

export interface RetryDlqState {
  attempts: number[];
  requestedDelays: number[];
  actualGaps: number[];
  finalJobStatus: string;
  finalTaggingStatus: string | null;
  dlqReceived: boolean;
  timedOut?: boolean;
}

export interface CronJobAudit {
  jobId: string;
  sendResult: string;
  sendDelaySeconds: number | null;
  errorCode: string | null;
}

export interface CronInvocationAudit {
  invocationId: string;
  scheduledAt: string;
  selectedCount: number;
  sentCount: number;
  failedCount: number;
  jobs: CronJobAudit[];
}

export interface RunQueueOptions {
  deployPath: string;
  apiKey: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: SpawnFn;
  poll?: () => Promise<RetryDlqState>;
  cronAudit?: CronInvocationAudit;
  secondCron?: CronInvocationAudit;
  retryDeadlineMs?: number;
  cronDeadlineMs?: number;
  overallDeadlineMs?: number;
  checkedAt?: string;
}

export interface QueueArtifact {
  profile: string;
  deploymentId: string;
  versionIds: string[];
  workerUrl: string;
  sourceDeploySha256: string;
  checks: Record<string, unknown>;
  error?: string;
  checkedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
  resumed?: { jobId: string; failJobId: string };
}

export function runQueue(options: RunQueueOptions): Promise<QueueArtifact>;

export function pollRetryDlq(options: {
  url: string;
  apiKey: string;
  jobId: string;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  spawn: SpawnFn;
  deadlineMs: number;
  progress?: (msg: string) => void;
}): Promise<RetryDlqState>;

export function cronAudit(spawn: SpawnFn, invocationId: string): Promise<CronInvocationAudit | null>;

export function runCronProbe(options: {
  spawn: SpawnFn;
  deadlineMs: number;
  progress?: (msg: string) => void;
}): Promise<{
  failJobId: string;
  failInFirstSelection: boolean;
  failIsFirst: boolean;
  firstAudit: CronInvocationAudit | null;
  secondAudit: CronInvocationAudit | null;
  timedOut: boolean;
}>;

export function runResume(options: {
  deployPath: string;
  apiKey: string;
  jobId: string;
  failJobId: string;
  spawn?: SpawnFn;
  awaitSecondMs?: number;
}): Promise<QueueArtifact>;

export function main(argv: string[]): Promise<void>;
