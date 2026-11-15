// Interpret GitHub Actions check runs and external commit statuses.
import { latestPerCheck } from "./merge-checks.mjs";

const RED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "PENDING_DEPLOYMENT"]);

// "unknown" never qualifies a head. Empty is distinct from both green and malformed.
export const ciVerdict = (rollup = []) => {
  if (!Array.isArray(rollup)) return "unknown";
  if (rollup.length === 0) return null;
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
