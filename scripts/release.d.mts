export declare const REPO: string;
export declare const PACKAGE: string;
export declare const BRANCH: string;
export declare const PUBLISH_WORKFLOW: string;
export declare const CI_WORKFLOW: string;
export declare const EXIT_NOTHING: number;

export type ReleaseOptions = { bump: string; yes: boolean; dryRun: boolean; help: boolean };
export declare function parseArgs(argv: readonly string[]): ReleaseOptions;

export declare function ciCommit(log: string): string | null;

export type ReleaseFacts = {
  remoteSha: string;
  ciSha: string;
  current: string;
  unreleased: number | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  next: string;
  ciStatus: string | null;
  ciConclusion: string | null;
  publishRunning: boolean;
  npmHasNext: boolean;
};
export declare function problems(facts: ReleaseFacts): string[];
export declare function warnings(facts: ReleaseFacts): string[];
