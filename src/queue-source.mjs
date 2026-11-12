import { isSha, parseJson } from "./github.mjs";

const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const QUERY = `query ConveyorQueue($owner: String!, $name: String!, $base: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: $base, first: ${PAGE_SIZE}, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state baseRefName headRefOid isDraft isCrossRepository mergeable
        statusCheckRollup {
          contexts(first: 99) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { name status conclusion startedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
              ... on StatusContext { context state createdAt targetUrl }
            }
          }
        }
      }
    }
  }
}`;

const PREFIX = ["gh", "api", "graphql", "-f", `query=${QUERY}`];
const FIELDS = ["owner=", "name=", "base=", "cursor="];

// gh transports GraphQL queries as POST. Accept only this fixed read document and raw string variables.
export const isQueueRead = (argv) =>
  PREFIX.every((value, i) => argv[i] === value) &&
  [11, 13].includes(argv.length) &&
  FIELDS.slice(0, (argv.length - PREFIX.length) / 2).every((field, i) =>
    argv[PREFIX.length + 2 * i] === "-f" && argv[PREFIX.length + 2 * i + 1]?.startsWith(field));

const rollupRows = (rollup) => {
  if (rollup === null) return [];
  const contexts = rollup?.contexts;
  return Array.isArray(contexts?.nodes) && contexts.nodes.length === contexts.totalCount ? contexts.nodes : null;
};

export const listQueue = (run, repo, base, readError) => {
  const [owner, name] = repo.split("/");
  const args = [...PREFIX, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `base=${base}`];
  const prs = new Map();
  const cursors = new Set();
  let total;
  let cursor;
  const partial = (reason) => ({ prs: [...prs.values()], complete: false, incompleteReason: reason });
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = run(cursor ? [...args, "-f", `cursor=${cursor}`] : args);
    if (result.status !== 0) {
      const error = readError("Could not reach GitHub or read the queue.");
      return prs.size ? partial(error) : { error };
    }
    const body = parseJson(result.stdout);
    const list = body?.data?.repository?.pullRequests;
    if (body?.errors?.length || !Array.isArray(list?.nodes) || list.nodes.length > PAGE_SIZE ||
      !Number.isSafeInteger(list.totalCount) || list.totalCount < 0 || typeof list.pageInfo?.hasNextPage !== "boolean") {
      const error = { code: "data_unavailable", message: "GitHub returned incomplete pull request data." };
      return prs.size ? partial(error) : { error };
    }
    total ??= list.totalCount;
    for (const pr of list.nodes) {
      if (!Number.isSafeInteger(pr?.number) || pr.number <= 0 || !isSha(pr.headRefOid) || typeof pr.title !== "string" ||
        pr.state !== "OPEN" || pr.baseRefName !== base || prs.has(pr.number)) {
        return partial({ code: "queue_changed", message: "The pull request list changed while it was being read." });
      }
      prs.set(pr.number, { ...pr, statusCheckRollup: rollupRows(pr.statusCheckRollup) });
    }
    if (total !== list.totalCount) return partial({ code: "queue_changed", message: "The pull request list changed while it was being read." });
    if (!list.pageInfo.hasNextPage) {
      return prs.size === total ? { prs: [...prs.values()], complete: true } :
        partial({ code: "queue_changed", message: "GitHub returned fewer pull requests than expected." });
    }
    cursor = list.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor) || list.nodes.length === 0) {
      return partial({ code: "data_unavailable", message: "GitHub did not return a usable next page." });
    }
    cursors.add(cursor);
  }
  return partial({ code: "queue_limit", message: `The queue exceeded the ${PAGE_SIZE * MAX_PAGES} pull request read limit.` });
};
