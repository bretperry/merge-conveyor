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

export interface Clearance {
  kind: "cleared" | "already_cleared";
  number: number;
  headSha: string;
}

export interface Consent {
  kind: "resumed" | "paused";
  changed: boolean;
  consentUntil: string | null;
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

export interface Client {
  queue(): Promise<Result<QueueSnapshot>>;
  preview(): Promise<Result<QueueSnapshot>>;
  explain(input: { number: number }): Promise<Result<Explanation>>;
  tick(): Promise<Result<TickOutcome>>;
  status(): Promise<Result<WorkerStatus>>;
  doctor(): Promise<Result<Diagnostics>>;
  report(input?: { days?: number }): Promise<Result<MergeReport>>;
  clear(input: { number: number; headSha: string }): Promise<Result<Clearance>>;
  pause(): Promise<Result<Consent>>;
  resume(): Promise<Result<Consent>>;
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
  ageAlarms: { pokeHours: number; tellHours: number };
  mergeMethod?: ConveyorConfig["mergeMethod"];
  autoUpdate?: boolean;
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
