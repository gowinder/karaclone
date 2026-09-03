/** phase0 remote-common 的类型声明（脚本为 ESM 运行时代码）。 */

export const REPO_ROOT: string;
export const WRANGLER: string;
export const PROVENANCE_KEYS: readonly string[];

export function parseArgs(argv: string[]): Record<string, string>;

export type SpawnFn = (cmd: string, args: string[]) => { stdout: string; stderr?: string; status: number | null; error?: Error };

export const defaultSpawn: SpawnFn;

export function runWrangler(spawn: SpawnFn, args: string[]): string;

export interface ProductionDeployment {
  deploymentId: string;
  versionIds: string[];
}

export function productionDeployment(spawn: SpawnFn): ProductionDeployment;

export interface DeployArtifact {
  profile: string;
  passed: boolean;
  workerUrl: string;
  deploymentId: string;
  versionIds: string[];
  sourceDeploySha256: string;
  [key: string]: unknown;
}

export function loadDeployArtifact(path: string, expectedProfile: string): DeployArtifact;

export function assertNoDrift(spawn: SpawnFn, deployArtifact: DeployArtifact, phase: string): ProductionDeployment;

export function atomicWriteJson(outPath: string, artifact: Record<string, unknown>): Promise<string>;

export function loadApiKey(envFilePath: string): string;
