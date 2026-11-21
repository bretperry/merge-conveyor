export interface Reason {
  code: string;
  message: string;
  checkUrl?: string;
  retryAt?: string;
}

export interface Entry {
  number: number;
  title: string;
  url: string;
  headSha: string;
  state: "ready" | "waiting" | "blocked" | "unknown";
  position: number | null;
  reasons: Reason[];
}

export interface Action {
  kind: "merge" | "update";
  number: number;
  headSha: string;
}

export interface QueueSnapshot {
  schemaVersion: 1;
  repo: string;
  base: string;
  observedAt: string;
  complete: boolean;
  globalBlockers: Reason[];
  entries: Entry[];
  nextAction: Action | null;
  nextActionKnown: boolean;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retryAt?: string } };

export interface Check {
  name: string;
  state: "green" | "red" | "pending" | "unknown" | null;
  url?: string;
}

export interface Explanation extends Omit<QueueSnapshot, "entries"> {
  entry: Entry;
  checks: Check[];
  checksComplete: boolean;
  holds: string[];
  nextStep: Reason;
}

export type RecordedAction =
  | { kind: "merged"; number: number; headSha: string; mergeSha: string; at: string }
  | { kind: "updated"; number: number; headSha: string; newHeadSha: string; at: string };

export type TickOutcome =
  | RecordedAction
  | { kind: "idle" | "blocked"; reason: Reason }
  | { kind: "unknown"; action: Action; reason: Reason };

export interface WorkerStatus {
  schemaVersion: 1;
  repo: string;
  base: string;
  stateHealth: "ok" | "legacy" | "corrupt";
  lastTickAt: string | null;
  lastSuccessfulTickAt: string | null;
  lastAction: RecordedAction | null;
  nextRetryAt: string | null;
  operation: { kind: Action["kind"]; number: number; headSha: string; since: string } | null;
  consentUntil: string | null;
  globalBlockers: Reason[];
}

export interface Diagnostics {
  repo: string;
  base: string;
  healthy: boolean;
  checks: Array<Reason & { ok: boolean }>;
}

export interface MergeReport {
  days: number;
  since: string;
  through: string;
  merged: number;
  unclocked: number;
  p50Minutes: number | null;
  p90Minutes: number | null;
  complete: boolean;
}

export type Clearance =
  | { kind: "cleared" | "already_cleared"; number: number; headSha: string }
  | { kind: "unknown"; number: number; headSha: string; reason: Reason };

export interface Consent {
  kind: "resumed" | "paused";
  changed: boolean;
  consentUntil: string | null;
}

export interface Approvals {
  approvals: { number: number; headSha: string; classes: string[] }[];
  expires: string;
}

export interface ConveyorConfig {
  repo?: string;
  base?: string;
  baseWorkflow?: string;
  releaseBranch?: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  autoUpdate?: boolean;
  clearancePublisherId?: number;
  clearanceContext?: string;
  consentHours?: number;
  stateName?: string;
}

export interface ClientOptions {
  cwd?: string;
  configPath?: string;
  config?: ConveyorConfig;
  /** Synchronous veto evaluated immediately before a worker write. */
  policy?: (input: { repo: string; base: string; action: Action; paths: string[] }) => boolean;
  /** Synchronous notification for worker reports and alarms. */
  notify?: (input: { repo: string; base: string; message: string }) => void;
}

export interface WorkerEvent {
  schemaVersion: 1;
  at: string;
  type: "tick_started" | "intent_journaled" | "tick_finished" | (string & {});
  action?: Action;
  baseSha?: string;
  outcome?: "merged" | "updated" | "idle" | "blocked" | "unknown" | "error";
  commands?: number;
  code?: string;
  result?: RecordedAction;
}

export interface Client {
  queue(): Promise<Result<QueueSnapshot>>;
  preview(): Promise<Result<QueueSnapshot>>;
  explain(input: { number: number }): Promise<Result<Explanation>>;
  tick(): Promise<Result<TickOutcome>>;
  status(): Promise<Result<WorkerStatus>>;
  doctor(): Promise<Result<Diagnostics>>;
  report(input?: { days?: number }): Promise<Result<MergeReport>>;
  /** Read-only: the event feed path and its newest events (default 200; 0 returns only the path). */
  events(input?: { limit?: number }): Promise<Result<{ path: string; events: WorkerEvent[] }>>;
  clear(input: { number: number; headSha: string }): Promise<Result<Clearance>>;
  pause(): Promise<Result<Consent>>;
  resume(): Promise<Result<Consent>>;
  /**
   * `hours` 1–168 opens an expiring window after `confirm` resolves to exactly true (the CLI supplies one that needs a typed yes at a terminal; a library caller's own function is trusted as given);
   * "off" pauses and needs no confirm.
   */
  window(input: { hours: number | "off"; confirm?: (input: { hours: number; repo: string; base: string }) => boolean | Promise<boolean> }): Promise<Result<Consent>>;
  /** Records a 24-hour yes for every held class each pull request touches, after `confirm` resolves to exactly true. */
  approve(input: { numbers: number[]; confirm?: (input: { approvals: Approvals["approvals"]; hours: number }) => boolean | Promise<boolean> }): Promise<Result<Approvals>>;
}

export declare function createClient(options?: ClientOptions): Client;

export declare const EXIT_CODES: Readonly<{ ok: 0; error: 1; usage: 2; unknownWrite: 3 }>;

type LegacyAdapter = (...args: any[]) => any;
type LegacyRun = (args: string[], timeout?: number, cwd?: string) => { status: number; stdout: string; stderr: string };

export interface LegacyConveyorConfig {
  base: string;
  baseWorkflow: string;
  release: { branch: string };
  switchVariable: string;
  clearedContext: string;
  stateName: string;
  /** Older state-file stems, read when `stateName`'s file is missing; writes go to `stateName`. */
  stateAliases?: string[];
  ageAlarms: { pokeHours: number; tellHours: number };
  mergeMethod?: ConveyorConfig["mergeMethod"];
  autoUpdate?: boolean;
  /** Opt in: a `merge` approval at a PR's exact head merges it with the window off. Default false. The `commando` adapter must honor its `consent` option. */
  mergeApprovals?: boolean;
  clearancePublisherId?: number;
  adapters: Record<
    "approved" | "changeDigest" | "gitDir" | "heldDigest" | "readHeld" | "activeUntil" | "commando" |
    "heldBy" | "isGateContext" | "wrangleMerge" | "approvedWork" | "approvalClock", LegacyAdapter
  > & { DOCS_ONLY: RegExp };
}

export interface LegacyConveyor {
  main(args: string[], options?: {
    cwd?: string;
    run?: LegacyRun;
    clock?: () => Date;
    out?: (message: string) => void;
    err?: (message: string) => void;
    env?: Record<string, string | undefined>;
    hook?: (command: string, input: string, env: Record<string, string | undefined>) => string;
    wrangle?: LegacyAdapter;
  }): Promise<number>;
  CLEARED_CONTEXT: string;
  ENABLED_VARIABLE: string;
  ENABLED_VALUE: string;
  STATE_NAME: string;
  LOG_NAME: string;
  LOCK_NAME: string;
  COMMANDO_WARN_HOURS: number;
  MERGE_WAIT_MINUTES: number;
  DEV_SETTLE_MINUTES: number;
  DEV_STUCK_MINUTES: number;
  MERGE_RETRY_MINUTES: number;
  UPDATE_FLIGHT_MINUTES: number;
  LOCK_HUNG_MINUTES: number;
  REPORT_DAYS: number;
  OUTBOX_MAX: number;
  RUN_TIMEOUT_MS: number;
  defaultRun: LegacyRun;
  readsOnly(args: string[]): boolean;
  classify: LegacyAdapter;
  readSwitch: LegacyAdapter;
  devState: LegacyAdapter;
  staleness: LegacyAdapter;
  percentile(values: number[], percentile: number): number | undefined;
  reportLine: LegacyAdapter;
  readOnlyRun(run: LegacyRun): LegacyRun;
}

export declare function createConveyor(config: LegacyConveyorConfig): LegacyConveyor;

type HoldPattern = [RegExp, string];

export declare const MAX_PR_FILES: number;
export declare const BASE_HOLDS: HoldPattern[];
export declare const PACKAGE_HOLDS: HoldPattern[];
export declare const LANGUAGE_HOLDS: HoldPattern[];
export declare function createHolds(patterns: HoldPattern[]): { heldBy(paths: string[]): string[]; pathsHeld(paths: string[], why: string): string[] };

export declare function createApprovals(options: {
  HOLD_PATTERNS: HoldPattern[];
  MAX_PR_FILES: number;
  heldBy: (paths: string[]) => string[];
  pathsHeld: (paths: string[], why: string) => string[];
  /** The log written in the git common dir. Default `conveyor-approvals.log`. */
  approvalsLog?: string;
  /** Older log names, read as well, so a yes recorded under one still counts. */
  approvalsLogAliases?: string[];
  boundedReads?: boolean;
}): Record<string, any>;

export declare function createMerge(options: { loadHeavyChecks: LegacyAdapter; isGateContext: (context: string) => boolean; base?: string; releaseBranch?: string; mergeMethod?: ConveyorConfig["mergeMethod"] }): Record<string, any>;

export declare function ciVerdict(rollup: unknown): "red" | "pending" | "green" | "unknown" | null;
