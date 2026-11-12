import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createApprovals } from "./approvals.mjs";
import { isSha, MERGE_METHODS, parseJson } from "./github.mjs";
import { BASE_HOLDS, LANGUAGE_HOLDS, MAX_PR_FILES, PACKAGE_HOLDS, createHolds } from "./holds.mjs";
import { listQueue } from "./queue-source.mjs";
import { takeLock, writePrivateJson } from "./state.mjs";
import { createWorker } from "./worker.mjs";

export const EXIT_CODES = Object.freeze({ ok: 0, error: 1, usage: 2, unknownWrite: 3 });

const HOUR = 3_600_000;
const INTERACTIVE_MS = 15_000;
const INTERACTIVE_CALLS = 160;
const WORKER_MS = 600_000;
const WORKER_CALLS = 1_200;
const COMMAND_MS = 15_000;
const CONSENT_FILE = "conveyor-consent.json";
const CONFIG_FILE = ".conveyor.json";
const REPO = /^[\w.-]+\/[\w.-]+$/u;
const CONTEXT = /^[a-z0-9][a-z0-9._/-]{0,99}$/iu;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const error = (code, message, retryAt) => ({ code, message, ...(retryAt ? { retryAt } : {}) });
const failed = (problem) => ({ ok: false, error: problem });
const success = (value) => ({ ok: true, value });
const invalid = (message) => failed(error("invalid_config", message));

const runCommand = (argv, { cwd, env, timeout }) => {
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd, env, timeout, encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  return { status: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "", code: child.error?.code };
};

const httpError = (result, command, now) => {
  const message = result.stderr ?? "";
  if (result.code === "ENOENT") return error(command === "gh" ? "missing_github_cli" : "missing_git",
    command === "gh" ? "Install GitHub CLI." : "Install Git.");
  if (result.code === "ETIMEDOUT") return error("read_timeout", "A command exceeded its time budget.");
  if (result.code === "BUDGET") return error("read_budget_exhausted", "The operation exceeded its read budget.");
  if (/\b429\b|rate limit|abuse detection/i.test(message)) {
    const seconds = /(?:^|\n)retry-after:\s*(\d{1,8})\s*(?:\n|$)/i.exec(message)?.[1];
    const epoch = /(?:^|\n)x-ratelimit-reset:\s*(\d{1,12})\s*(?:\n|$)/i.exec(message)?.[1];
    const retryMs = seconds ? now.getTime() + Number(seconds) * 1_000 : epoch ? Number(epoch) * 1_000 : 0;
    return error("rate_limited", "GitHub rate limited this request.", retryMs > now.getTime() ? new Date(retryMs).toISOString() : undefined);
  }
  if (/\bHTTP 401\b|bad credentials|gh auth login|not logged in|authentication required/i.test(message)) {
    return error("missing_auth", "Authenticate GitHub CLI for this repository.");
  }
  if (/\bHTTP 403\b|forbidden|resource not accessible|insufficient scopes/i.test(message)) {
    return error("insufficient_permission", "The GitHub credential does not have permission for this operation.");
  }
  if (/\bHTTP 404\b|could not resolve to a (repository|pullrequest)/i.test(message)) {
    return error("not_found", "GitHub could not find the requested resource with this credential.");
  }
  return error("data_unavailable", "Could not reach GitHub or read the required data.");
};

const repoFromOrigin = (raw) => {
  const remote = raw.trim();
  const ssh = /^git@github\.com:([\w.-]+\/[\w.-]+)$/i.exec(remote)?.[1];
  if (ssh) return ssh.replace(/\.git$/i, "");
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:"].includes(url.protocol) || url.port || url.search || url.hash) return null;
    const path = url.pathname.replace(/^\//, "").replace(/\.git\/?$/i, "").replace(/\/$/, "");
    return REPO.test(path) ? path : null;
  } catch {
    return null;
  }
};

const configKeys = new Set(["repo", "base", "baseWorkflow", "releaseBranch", "mergeMethod", "autoUpdate", "clearancePublisherId", "clearanceContext", "consentHours", "stateName"]);
const readConfig = (root, options) => {
  let file = {};
  const path = options.configPath ? resolve(options.cwd ?? process.cwd(), options.configPath) : join(root, CONFIG_FILE);
  try {
    file = parseJson(readFileSync(path, "utf8"));
  } catch (problem) {
    if (problem.code !== "ENOENT" || options.configPath) return invalid("Could not read the Conveyor config file.");
  }
  if (!isObject(file) || (options.config !== undefined && !isObject(options.config))) return invalid("Conveyor config must be a JSON object.");
  const supplied = { ...file, ...options.config };
  if (Object.keys(supplied).some((key) => !configKeys.has(key))) return invalid("Conveyor config contains an unsupported field.");
  const config = {
    base: "main", baseWorkflow: "ci.yml", mergeMethod: "merge", autoUpdate: false,
    clearanceContext: "conveyor/cleared", consentHours: 8, stateName: "conveyor",
    ...supplied,
  };
  if (config.repo !== undefined && (typeof config.repo !== "string" || !REPO.test(config.repo))) return invalid("repo must be a GitHub owner/repository pair.");
  const branch = (value) => typeof value === "string" && !!value && !/^[-.]|[\s~^:?*\[\\]|\.\.|@\{|\/\//u.test(value) &&
    !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && value !== "@";
  if (!branch(config.base) || (config.releaseBranch !== undefined && (!branch(config.releaseBranch) || config.releaseBranch === config.base))) {
    return invalid("base and releaseBranch must be distinct branch names.");
  }
  if (typeof config.baseWorkflow !== "string" || !config.baseWorkflow.trim() || /[\r\n]/u.test(config.baseWorkflow)) return invalid("baseWorkflow must name a GitHub Actions workflow.");
  if (!MERGE_METHODS.includes(config.mergeMethod) || typeof config.autoUpdate !== "boolean") return invalid("Use a supported mergeMethod and a boolean autoUpdate.");
  if (config.clearancePublisherId !== undefined && !positive(config.clearancePublisherId)) return invalid("clearancePublisherId must be a positive GitHub user ID.");
  if (typeof config.clearanceContext !== "string" || !CONTEXT.test(config.clearanceContext)) return invalid("clearanceContext must be a GitHub status context.");
  if (!positive(config.consentHours) || config.consentHours > 24) return invalid("consentHours must be an integer from 1 to 24.");
  if (typeof config.stateName !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(config.stateName) ||
    ["conveyor-consent", "conveyor-approvals"].includes(config.stateName.toLowerCase())) return invalid("stateName must be a filename stem.");
  return success(config);
};

const readConsent = (dir, scope, now) => {
  let record;
  try {
    record = parseJson(readFileSync(join(dir, CONSENT_FILE), "utf8"));
  } catch (problem) {
    return problem.code === "ENOENT" ? { on: false } : { on: false, unreadable: true };
  }
  if (!isObject(record) || record.version !== 1 || typeof record.repo !== "string" || typeof record.base !== "string" ||
    (record.until !== null && (typeof record.until !== "string" || !Number.isFinite(Date.parse(record.until))))) return { on: false, unreadable: true };
  if (record.repo !== scope.repo || record.base !== scope.base || record.until === null) return { on: false };
  const remaining = Date.parse(record.until) - now.getTime();
  return remaining > 0 && remaining <= 24 * HOUR ? { on: true, value: record.until } : { on: false };
};

const setConsent = (dir, config, now, on) => {
  const path = join(dir, CONSENT_FILE);
  const release = takeLock(`${path}.lock`);
  if (!release) return failed(error("operator_locked", "A worker tick or consent change is running. Retry after it finishes."));
  try {
    const existing = readConsent(dir, config, now);
    if (existing.unreadable) return failed(error("consent_unavailable", "The consent file is unreadable or unsupported."));
    if (existing.on === on) return success({ kind: on ? "resumed" : "paused", changed: false, consentUntil: existing.value ?? null });
    const consentUntil = on ? new Date(now.getTime() + config.consentHours * HOUR).toISOString() : null;
    writePrivateJson(path, { version: 1, repo: config.repo, base: config.base, until: consentUntil });
    return success({ kind: on ? "resumed" : "paused", changed: true, consentUntil });
  } finally {
    release();
  }
};

const holds = [...BASE_HOLDS, ...PACKAGE_HOLDS, ...LANGUAGE_HOLDS];
const holdPolicy = createHolds(holds);
const adapters = createApprovals({ HOLD_PATTERNS: holds, MAX_PR_FILES, ...holdPolicy, boundedReads: true });

const connect = (options, dependencies, worker) => {
  const cwd = options.cwd ?? process.cwd();
  const clock = dependencies.clock ?? (() => new Date());
  const spawn = dependencies.run ?? runCommand;
  const deadline = performance.now() + (worker ? WORKER_MS : INTERACTIVE_MS);
  const maxCalls = worker ? WORKER_CALLS : INTERACTIVE_CALLS;
  let calls = 0;
  let lastFailure;
  let root = cwd;
  let repo;
  const run = (argv, timeout = COMMAND_MS) => {
    const remaining = Math.floor(deadline - performance.now());
    const result = ++calls > maxCalls || remaining <= 0
      ? { status: 1, stdout: "", code: "BUDGET" }
      : spawn(argv, {
        cwd: root,
        timeout: Math.min(timeout, remaining, COMMAND_MS),
        env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
          ...(repo ? { GH_REPO: `github.com/${repo}` } : {}) },
      });
    if (result.status === 0) return result;
    lastFailure = httpError(result, argv[0], clock());
    return { ...result, stderr: lastFailure.message };
  };
  const readError = (fallback) => lastFailure && lastFailure.code !== "data_unavailable" ? lastFailure : error("data_unavailable", fallback);
  const worktree = run(["git", "rev-parse", "--show-toplevel"]);
  if (worktree.status !== 0 || !worktree.stdout.trim()) return failed(lastFailure?.code === "missing_git" ? lastFailure : error("not_a_repository", "Run Conveyor inside a Git checkout."));
  root = worktree.stdout.trim();
  const cfg = readConfig(root, options);
  if (!cfg.ok) return cfg;
  const config = cfg.value;
  const origin = run(["git", "remote", "get-url", "origin"]);
  const inferred = origin.status === 0 ? repoFromOrigin(origin.stdout) : null;
  if (!inferred || (config.repo && config.repo.toLowerCase() !== inferred.toLowerCase())) return invalid("Configure a GitHub origin that matches the Conveyor repository.");
  repo = (config.repo ?? inferred).toLowerCase();
  const scoped = { ...config, repo };
  const dir = adapters.gitDir(run, root);
  const viewer = (runner) => {
    const result = runner(["gh", "api", "user"]);
    const user = result.status === 0 ? parseJson(result.stdout) : null;
    return positive(user?.id) ? user : null;
  };
  const latestClearance = (runner, head, context) => {
    for (let page = 1; page <= 10; page += 1) {
      const result = runner(["gh", "api", `repos/{owner}/{repo}/commits/${head}/statuses?per_page=100&page=${page}`]);
      const statuses = result.status === 0 ? parseJson(result.stdout) : null;
      if (!Array.isArray(statuses) || statuses.some((status) => typeof status?.context !== "string")) {
        return { error: readError("Could not read clearance for the current head.") };
      }
      const status = statuses.find((item) => item.context.toLowerCase() === context.toLowerCase());
      if (status || statuses.length < 100) return { status: status?.context === context ? status : undefined };
    }
    return { error: error("data_unavailable", "The commit status history exceeded the clearance read limit.") };
  };
  const readSwitch = (gitDir, now) => {
    const sw = readConsent(gitDir, scoped, now);
    return { ...sw, why: sw.unreadable ? "could not read worker consent" : sw.on ? undefined : "Conveyor is paused" };
  };
  const engine = createWorker({
    base: config.base, baseWorkflow: config.baseWorkflow, release: { branch: config.releaseBranch ?? (config.base === "release" ? "main" : "release") },
    switchVariable: "CONVEYOR_CONSENT", clearedContext: config.clearanceContext, clearancePublisherId: config.clearancePublisherId,
    stateName: config.stateName, ageAlarms: { pokeHours: 24, tellHours: 48 }, mergeMethod: config.mergeMethod, autoUpdate: config.autoUpdate,
    adapters: { ...adapters, heldBy: holdPolicy.heldBy,
      activeUntil: (gitDir, now) => { const sw = readSwitch(gitDir, now); return sw.on ? new Date(sw.value) : null; },
      commando: () => 1, wrangleMerge: () => 1, isGateContext: () => false, approvedWork: () => () => [],
      approvalClock: () => new Map(), DOCS_ONLY: /^(?!)$/,
    },
  }, {
    repo, shipFreeze: !!config.releaseBranch, readSwitch, readError, viewer, latestClearance,
    lockConsent: () => takeLock(join(dir, `${CONSENT_FILE}.lock`)),
    listOpen: (runner) => listQueue(runner, repo, config.base, readError),
    policy: options.policy && ((action, paths) => {
      try {
        return options.policy({ repo, base: config.base, action, paths: [...paths] }) === true;
      } catch {
        return false;
      }
    }),
    notify: options.notify && ((message) => options.notify({ repo, base: config.base, message })),
  });
  return success({ engine, config: scoped, ctx: { cwd: root, dir, run, clock, env: {}, out: () => {}, err: () => {} }, readError });
};

const normalize = (result) => result.error ? failed(result.error) : success(result.value);

/**
 * Standalone client. GitHub commands run in the local checkout with authenticated gh.
 * The second argument is an internal runner and clock seam for contract fixtures.
 */
export const createClient = (options = {}, dependencies = {}) => {
  const call = async (operation, perform) => {
    if (!isObject(options) || (options.cwd !== undefined && typeof options.cwd !== "string") ||
      (options.configPath !== undefined && typeof options.configPath !== "string") ||
      (options.policy !== undefined && typeof options.policy !== "function") ||
      (options.notify !== undefined && typeof options.notify !== "function")) return invalid("Invalid Conveyor client options.");
    try {
      const opened = connect(options, dependencies, operation === "tick");
      return opened.ok ? await perform(opened.value) : opened;
    } catch {
      return failed(error("local_error", "Conveyor could not complete the operation. Check the local checkout and worker files."));
    }
  };
  const queue = () => call("queue", ({ engine, ctx }) => normalize(engine.inspectQueue(ctx)));
  return {
    queue,
    preview: queue,
    explain: (input) => positive(input?.number) ? call("explain", ({ engine, ctx }) => normalize(engine.inspectExplain(input.number, ctx)))
      : Promise.resolve(failed(error("invalid_input", "Use a positive pull request number."))),
    tick: () => call("tick", async ({ engine, ctx }) => normalize(await engine.executeTick(ctx))),
    status: () => call("status", ({ engine, ctx }) => normalize(engine.inspectStatus(ctx))),
    doctor: () => call("doctor", ({ engine, ctx }) => normalize(engine.inspectDoctor(ctx))),
    report: (input) => {
      const days = input?.days ?? 7;
      if (!positive(days) || days > 90) return Promise.resolve(failed(error("invalid_input", "Use a report window from 1 to 90 days.")));
      return call("report", ({ engine, ctx, readError }) => {
        const { line, error: reportError, ...stats } = engine.reportLine(ctx.cwd, ctx.run, ctx.clock(), days);
        return reportError ? failed(readError("Could not read merge timing data.")) : success(stats);
      });
    },
    clear: (input) => positive(input?.number) && isSha(input?.headSha)
      ? call("clear", ({ engine, ctx }) => normalize(engine.clearExact(input, ctx)))
      : Promise.resolve(failed(error("invalid_input", "Use a pull request number and the full reviewed head SHA."))),
    pause: () => call("pause", ({ config, ctx }) => setConsent(ctx.dir, config, ctx.clock(), false)),
    resume: () => call("resume", ({ config, ctx }) => config.clearancePublisherId
      ? setConsent(ctx.dir, config, ctx.clock(), true)
      : invalid("Configure the trusted clearance publisher before resuming the worker.")),
  };
};
