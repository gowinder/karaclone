/** phase0 decide 决策器的类型声明（脚本为 ESM 运行时代码）。 */

export interface DecideOptions {
  artifactsDir?: string;
  repoRoot?: string;
  git?: (args: string[]) => string;
  gitExit?: (args: string[]) => number;
  checkedAt?: string;
}

export interface DecideResult {
  decision: "GO" | "NO-GO";
  failedGates: string[];
  gates: Record<string, boolean>;
  checkedAt: string;
  lockedVersions: Record<string, string>;
  exemptions: Array<{ gate: string; note: string }>;
  evidence: Record<string, unknown>;
  failures: string[];
  canonicalSha256: string;
}

export function decide(options?: DecideOptions): Promise<DecideResult>;

export function main(argv: string[]): Promise<void>;
