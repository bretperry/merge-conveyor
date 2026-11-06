// Interpret GitHub CI rollups without project policy.
// Used by: the conveyor CLI and the package tests.
// Exports: ciVerdict.
// One PR's checks as one word: red if any failed, pending if any still running, green, or null with none.
// A skipped or neutral check counts as passing: draft PRs skip their heavy jobs on purpose.
const RED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
export const ciVerdict = (rollup = []) => {
  if (rollup.length === 0) return null;
  // A check run carries status + conclusion; a commit status carries only state.
  const outcomes = rollup.map((c) => c.conclusion || c.state || "");
  if (outcomes.some((o) => RED.has(o))) return "red";
  if (rollup.some((c) => (c.status ? c.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(c.state)))) return "pending";
  return "green";
};

