// Interpret GitHub Actions check runs and external commit statuses.
import { latestPerCheck } from "./merge-checks.mjs";

const RED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "PENDING_DEPLOYMENT"]);
// The lenient reading's red: STALE is not in it.
const LENIENT_RED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// The pre-0.2 reading: red if any row failed, pending if any is still running, else green. A completed
// row with an outcome it doesn't know (STALE included) reads green, and it never says "unknown", so a
// caller that merges on its green accepts those rows. The default reading refuses them.
const lenientVerdict = (rollup) => {
  // A check run carries status + conclusion; a commit status carries only state.
  const outcomes = rollup.map((row) => row?.conclusion || row?.state || "");
  if (outcomes.some((outcome) => LENIENT_RED.has(outcome))) return "red";
  if (rollup.some((row) => (row?.status ? row.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(row?.state)))) return "pending";
  return "green";
};

// "unknown" never qualifies a head. Empty is distinct from both green and malformed.
// `{ lenient: true }` gives the pre-0.2 reading above; a non-array is still "unknown" there.
export const ciVerdict = (rollup = [], { lenient = false } = {}) => {
  if (!Array.isArray(rollup)) return "unknown";
  if (rollup.length === 0) return null;
  if (lenient) return lenientVerdict(rollup);
  const outcomes = rollup.map((row) => {
    if (row?.status === "COMPLETED") return row.conclusion;
    if (row?.status) return PENDING.has(row.status) ? row.status : undefined;
    return row?.state;
  });
  if (outcomes.some((outcome) => RED.has(outcome))) return "red";
  if (outcomes.some((outcome) => !GREEN.has(outcome) && !PENDING.has(outcome))) return "unknown";
  return outcomes.some((outcome) => PENDING.has(outcome)) ? "pending" : "green";
};

export const checkRows = (rollup) => {
  // gh's rollup is capped at 100 contexts and does not expose pagination in this command.
  if (!Array.isArray(rollup) || rollup.length >= 100) return null;
  if (rollup.some((row) => row?.__typename === "CheckRun"
    ? typeof row.name !== "string" || !row.name || typeof row.status !== "string"
    : row?.__typename !== "StatusContext" || typeof row.context !== "string" || !row.context || typeof row.state !== "string")) return null;
  const rows = rollup.map((row) => {
    if (row.__typename === "StatusContext") return { ...row, name: row.context, workflow: "status:", startedAt: row.createdAt ?? row.startedAt };
    const workflowName = row.checkSuite?.workflowRun?.workflow?.name ?? row.workflowName;
    return { ...row, workflowName, workflow: `check:${workflowName ?? ""}` };
  });
  // External check runs need not have workflow names. With no provider ID in the rollup, same-name
  // checks can be independent. Keep them all rather than letting one provider's green hide a red.
  return [
    ...latestPerCheck(rows.filter((row) => row.__typename === "StatusContext" || row.workflowName)),
    ...rows.filter((row) => row.__typename === "CheckRun" && !row.workflowName),
  ];
};
