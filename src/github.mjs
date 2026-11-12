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

const isContext = (value) => typeof value === "string" && value.trim().length > 0;
const isAppId = (id) => Number.isSafeInteger(id) && id > 0;
const isRulesetCheck = (check) => isContext(check?.context) &&
  (check.integration_id === undefined || isAppId(check.integration_id));
const isClassicCheck = (check) => isContext(check?.context) &&
  (check.app_id == null || check.app_id === -1 || isAppId(check.app_id));

export const hasStrictChecks = (run, branch) => {
  const encoded = encodeURIComponent(branch);
  const active = run(["gh", "api", `repos/{owner}/{repo}/rules/branches/${encoded}?per_page=100`]);
  const rules = active.status === 0 ? parseJson(active.stdout) : null;
  if (Array.isArray(rules) && rules.some((rule) => {
    if (rule?.type !== "required_status_checks" || rule.parameters?.strict_required_status_checks_policy !== true) return false;
    const checks = rule.parameters.required_status_checks;
    return Array.isArray(checks) && checks.length > 0 && checks.every(isRulesetCheck);
  })) return true;
  // The rules endpoint lists rulesets. Classic branch protection has a separate endpoint.
  const classic = run(["gh", "api", `repos/{owner}/{repo}/branches/${encoded}/protection/required_status_checks`]);
  const protection = classic.status === 0 ? parseJson(classic.stdout) : null;
  if (protection?.strict !== true) return false;
  const { checks = [], contexts = [] } = protection;
  return Array.isArray(checks) && checks.every(isClassicCheck) &&
    Array.isArray(contexts) && contexts.every(isContext) && checks.length + contexts.length > 0;
};

// GitHub enforces the head SHA and branch rules on submission. Deployment must restrict the
// worker to the intended base as the API cannot atomically assert the PR's target branch.
export const mergePull = (run, number, head, method) =>
  run(["gh", "api", "--method", "PUT", `repos/{owner}/{repo}/pulls/${number}/merge`, "-f", `sha=${head}`, "-f", `merge_method=${method}`]);

export const updatePull = (run, number, head) =>
  run(["gh", "api", "--method", "PUT", `repos/{owner}/{repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${head}`]);
