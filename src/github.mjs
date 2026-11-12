// Shared GitHub write and reconciliation primitives. The supplied runner never uses a shell.
export const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const isSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
export const MERGE_METHODS = ["merge", "squash", "rebase"];

export const readPull = (run, number, fields = []) => {
  const result = run(["gh", "pr", "view", String(number), "--json", ["number", "state", "baseRefName", "headRefOid", ...fields].join(",")]);
  const pr = result.status === 0 ? parseJson(result.stdout) : null;
  return pr?.number === number && ["OPEN", "CLOSED", "MERGED"].includes(pr.state) && typeof pr.baseRefName === "string" && pr.baseRefName && isSha(pr.headRefOid) ? pr : null;
};

export const readMerge = (run, number) => {
  const pr = readPull(run, number, ["mergedAt", "mergeCommit"]);
  if (pr?.state === "MERGED" && (!isSha(pr.mergeCommit?.oid) || typeof pr.mergedAt !== "string" || !Number.isFinite(Date.parse(pr.mergedAt)))) return null;
  return pr;
};

export const hasStrictChecks = (run, branch) => {
  const encoded = encodeURIComponent(branch);
  const active = run(["gh", "api", `repos/{owner}/{repo}/rules/branches/${encoded}?per_page=100`]);
  const rules = active.status === 0 ? parseJson(active.stdout) : null;
  const configured = (contexts) => Array.isArray(contexts) && contexts.length > 0;
  if (Array.isArray(rules) && rules.some((rule) => rule?.type === "required_status_checks" &&
    rule.parameters?.strict_required_status_checks_policy === true && configured(rule.parameters.required_status_checks))) return true;
  // The rules endpoint lists rulesets. Classic branch protection has a separate endpoint.
  const classic = run(["gh", "api", `repos/{owner}/{repo}/branches/${encoded}/protection/required_status_checks`]);
  const protection = classic.status === 0 ? parseJson(classic.stdout) : null;
  return protection?.strict === true && (configured(protection.checks) || configured(protection.contexts));
};

// GitHub enforces the head SHA and branch rules on submission. Deployment must restrict the
// worker to the intended base as the API cannot atomically assert the PR's target branch.
export const mergePull = (run, number, head, method) =>
  run(["gh", "api", "--method", "PUT", `repos/{owner}/{repo}/pulls/${number}/merge`, "-f", `sha=${head}`, "-f", `merge_method=${method}`]);

export const updatePull = (run, number, head) =>
  run(["gh", "api", "--method", "PUT", `repos/{owner}/{repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${head}`]);
