/** phase0 write-preflight 的类型声明（脚本为 CJS/ESM 运行时代码）。 */

export interface BillingPageItem {
  subscriptionIdSha256: string;
  ratePlanId: string;
  state: "Trial" | "Provisioned" | "Paid" | "AwaitingPayment" | "Cancelled" | "Failed" | "Expired";
  price: number;
  scope: string | null;
  sets: string[];
  isContract: boolean;
  externallyManaged: boolean;
}

export interface PageProjection {
  page: number;
  perPage: number;
  totalCount: number;
  count: number;
  items: BillingPageItem[];
  canonicalSha256: string | null;
}

export interface FinalizedPageProjection extends Omit<PageProjection, "canonicalSha256"> {
  /** canonical-json 自哈希（排除 canonicalSha256 键）。 */
  canonicalSha256: string;
}

export interface PreflightSummary {
  whoamiAccountIdSha256: string;
  billingRequestAccountIdSha256: string;
  pageCount: number;
  totalCount: number;
  projectedCount: number;
  uniqueSubscriptionIdCount: number;
  subscriptionProjectionSha256: string;
  activeOrPendingSubscriptionCount: number;
  contractOrExternallyManagedCount: number;
  subscriptionRiskFree: boolean;
  upstreamCommit: string;
  extensionVersion: string;
  mobileVersion: string;
  checkedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
  pageProjections: FinalizedPageProjection[];
  subscriptionProjection: BillingPageItem[];
}

export type WhoamiFn = () => string;
export type BillingFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface RunPreflightOptions {
  whoami?: WhoamiFn;
  fetchImpl?: BillingFetch;
  checkedAt?: string;
}

export function runPreflight(options?: RunPreflightOptions): Promise<PreflightSummary>;

export function main(argv: string[]): Promise<void>;

export const VALID_STATES: readonly [
  "Trial",
  "Provisioned",
  "Paid",
  "AwaitingPayment",
  "Cancelled",
  "Failed",
  "Expired",
];
export const ACTIVE_STATES: readonly ["Trial", "Provisioned", "Paid", "AwaitingPayment"];
export const BILLING_URL_RE: RegExp;

export function projectSubscription(item: unknown): BillingPageItem;

export function projectPage(
  page: number,
  perPage: number,
  totalCount: number,
  count: number,
  result: unknown[],
): PageProjection;

export function finalizePageProjection(pageProjection: PageProjection): Promise<FinalizedPageProjection>;
