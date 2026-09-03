/** phase0 capture-workers-plan-entitlement 的类型声明。 */

export const SCHEMA_VERSION: string;
export const EXTRACTION_RULES_VERSION: number;
export const SELECTOR_VERSION: number;
export const DASHBOARD_HOST: "dash.cloudflare.com";
export const PLAN_PATH_PREFIX: "/workers/plans";
export const JSON_NAME: string;
export const HTML_NAME: string;
export const PNG_NAME: string;
export const SECRET_PATTERNS: RegExp[];

export function buildCanonicalUrl(accountId: string): string;

export function verifyCanonicalUrl(url: string, expectedAccountSha: string): string;

export function extractWorkersFreeEvidence(text: string): string;

export function extractAccountIdFromDom(url: string, domText: string): string;

export function scanDomForSecrets(text: string): true;

export function redactDom(dom: unknown): string;

export interface SessionVerification {
  chromePid: number;
  launchArgs: string[];
  endpointUrl: string;
  expectedUserDataDir: string;
  expectedNonce: string;
  actualProfilePath: string;
  port: number;
}

export function verifySession(session: SessionVerification): string[];

export interface AccountTrio {
  dashboardAccountIdSha256: string;
  apiAccountIdSha256: string;
  deployAccountIdSha256: string | null;
}

export function verifyAccountTrio(trio: AccountTrio): true;

export interface SessionProjection {
  chromePid: number;
  expectedUserDataDir: string;
  actualProfilePath: string;
  endpointUrl: string;
  launchArgsSha256: string;
  profileSessionNonceSha256: string;
  sessionValidated: boolean;
}

export interface EntitlementArtifact {
  schemaVersion: string;
  extractionRulesVersion: number;
  selectorVersion: number;
  canonicalDashboardUrl: string;
  normalizedSelectorText: string;
  renderedDomEvidence: string;
  urlSha256: string;
  textSha256: string;
  domSha256: string;
  screenshotSha256: string;
  accountIdSha256: string;
  session: SessionProjection;
  capturedAt: string;
  reviewedBy: string;
  reviewedAt: string;
  canonicalSha256: string | null;
  passed: boolean;
}

export interface BuildArtifactInput {
  canonicalDashboardUrl: string;
  normalizedSelectorText: string;
  redactedDom: string;
  accountId: string;
  screenshotSha256: string;
  session: SessionProjection;
  capturedAt: string;
  reviewedBy: string;
  reviewedAt: string;
}

export function buildArtifact(input: BuildArtifactInput): Promise<EntitlementArtifact>;

export interface CollectorDeps {
  makeTempDir(prefix: string): string;
  spawnChrome(args: { userDataDir: string; port: number }): number;
  getJson(url: string): Promise<{ webSocketDebuggerUrl?: string } | unknown>;
  getProcessArgs(pid: number): string[];
  promptUser(message: string): Promise<void>;
  killChrome(pid: number): void;
  cleanupTemp(dir: string): void;
  writeFile(path: string, content: string | Uint8Array): void;
  cdpEvaluate(): Promise<{ url: string; dom: string; text: string; accountPath: string }>;
  cdpScreenshot(): Promise<Buffer>;
}

export const defaultDeps: CollectorDeps;

export interface RunCollectorOptions {
  deps?: CollectorDeps;
  accountIdSourcePath: string;
  outDir: string;
  capturedAt?: string;
  reviewedBy?: string;
  fixedPort?: number | null;
}

export function runCollector(options: RunCollectorOptions): Promise<EntitlementArtifact>;

export function main(argv: string[]): Promise<void>;
