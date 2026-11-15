// Keep the newest run of each named workflow check.
// Used by: the conveyor CLI and the package tests.
// Exports: latestPerCheck.
// A draft run and a ready run on one head can both be listed. Keep the newest per (workflow, name),
// so a superseded draft `skipping` can't mask the ready run.
export const latestPerCheck = (rows) => {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.workflow ?? ""}\u0000${row.name ?? ""}`;
    const prev = latest.get(key);
    if (prev === undefined || (row.startedAt ?? "") >= (prev.startedAt ?? "")) latest.set(key, row);
  }
  return [...latest.values()];
};

