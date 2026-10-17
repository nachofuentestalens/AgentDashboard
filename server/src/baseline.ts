import { git } from "./git.ts";
import { HttpError } from "./http.ts";

export const gitIdentity = ["-c", "user.name=AgentDashboard", "-c", "user.email=agentdashboard@localhost"];

export async function checkedGit(repo: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(repo, args, input, env);
  if (!result.ok) throw new HttpError(result.stderr || result.stdout || "Git operation failed.", 409);
  return result.stdout;
}

// merge-tree creates objects only: conflicts never dirty either checkout or its index.
export async function mergeCommit(repo: string, base: string, incoming: string, message: string): Promise<string> {
  if ((await git(repo, ["merge-base", "--is-ancestor", incoming, base])).ok) return base;
  if ((await git(repo, ["merge-base", "--is-ancestor", base, incoming])).ok) return incoming;
  const merged = await git(repo, ["merge-tree", "--write-tree", "--allow-unrelated-histories", base, incoming]);
  if (!merged.ok)
    throw new HttpError(
      `Baseline integration is blocked. Both checkouts are preserved. Resolve the conflicting changes before retrying.\n${(merged.stdout || merged.stderr).slice(0, 4000)}`,
      409,
    );
  const tree = merged.stdout.split(/\r?\n/)[0]!;
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new HttpError("Git did not return a valid merged tree.", 409);
  return checkedGit(repo, [...gitIdentity, "commit-tree", tree, "-p", base, "-p", incoming], message);
}
