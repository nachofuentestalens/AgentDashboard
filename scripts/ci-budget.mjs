// Fails CI when its slowest job exceeds the time budget (docs/CI.md). Jobs run in parallel, so the slowest
// job is what a pull request waits for; runner queueing is excluded because no change can fix it.
const env = process.env;
const budget = Number(env.CI_BUDGET_SECONDS);
const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;
const response = await fetch(url, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" } });
if (!response.ok) throw new Error(`Listing this run's jobs failed (HTTP ${response.status}).`);

// This job is still in progress, so it measures only the finished ones.
const jobs = (await response.json()).jobs
  .filter((job) => job.status === "completed" && job.started_at && job.completed_at)
  .map((job) => ({ name: job.name, seconds: Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000) }))
  .sort((a, b) => b.seconds - a.seconds);

const table = ["| Job | Seconds |", "| --- | ---: |", ...jobs.map((job) => `| ${job.name} | ${job.seconds} |`)].join("\n");
const slowest = jobs[0];
const verdict =
  slowest && slowest.seconds > budget
    ? `CI is over budget: "${slowest.name}" took ${slowest.seconds}s, the limit is ${budget}s. Optimize the change (or the suite) to fit. ` +
      `If that is impossible, justify why in the pull request and raise CI_BUDGET_SECONDS in .github/workflows/ci.yml and docs/CI.md to the new minimum.`
    : `CI is within budget: slowest job ${slowest ? `"${slowest.name}" ${slowest.seconds}s` : "none"} of ${budget}s.`;

console.log(`${table}\n\n${verdict}`);
if (env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(env.GITHUB_STEP_SUMMARY, `## CI time budget\n\n${table}\n\n${verdict}\n`);
}
if (!slowest || slowest.seconds > budget) process.exitCode = 1;
