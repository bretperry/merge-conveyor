// The scheduler consumes observations in order. A merge wins over an update, and
// missing evidence before that merge can change the result.
export const rankedCandidates = (prs, state, now, retryMs, reconciledOpen) => {
  const retryAt = (key) => {
    const until = Date.parse(state.attempts[key]) + retryMs;
    return until > now.getTime() ? new Date(until).toISOString() : undefined;
  };
  return prs.filter((pr) => pr.kind === "cleared")
    .map((pr) => ({ pr, mergeRetryAt: retryAt(`${pr.number}@${pr.head}`), updateRetryAt: retryAt(`update:${pr.number}@${pr.head}`) }))
    .toSorted(({ pr: a }, { pr: b }) => Number(a.number === reconciledOpen) - Number(b.number === reconciledOpen) ||
      Date.parse(a.clearedAt) - Date.parse(b.clearedAt) || a.number - b.number);
};

export const candidateDecision = ({ pr, mergeRetryAt, updateRetryAt }, { held, classes, moved }, autoUpdate) => {
  if (mergeRetryAt) return { kind: "waiting", code: "retry_wait", message: "Waiting to retry this head.", retryAt: mergeRetryAt };
  if (held?.error) return { kind: "unknown", code: "holds_unavailable", message: "Could not verify changed paths and holds." };
  if (classes?.length) return { kind: "blocked", code: "hold_approval_required", message: `Separate approval required: ${classes.join(", ")}.`, holds: classes };
  if (moved?.error) return { kind: "unknown", code: "base_comparison_unavailable", message: "Could not compare this head with the base." };
  if (!moved.stale) return { kind: "merge", code: "checks_passed", message: "Required checks passed." };
  if (pr.fork) return { kind: "blocked", code: "fork_update_required", message: "Update this fork branch against the base." };
  if (!autoUpdate) return { kind: "waiting", code: "branch_update_required", message: "Update this branch against the base." };
  if (updateRetryAt) return { kind: "waiting", code: "retry_wait", message: "Waiting to retry the branch update.", retryAt: updateRetryAt };
  return { kind: "update", code: "branch_update_ready", message: "Ready to update from the base." };
};

export const chooseAction = (observations) => {
  let update;
  for (const observation of observations) {
    switch (observation.decision.kind) {
      case "unknown": return { known: false };
      case "merge": return { known: true, selected: observation };
      case "update": update ??= observation; break;
    }
  }
  return { known: true, selected: update };
};
