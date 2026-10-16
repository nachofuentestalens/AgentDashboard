import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd: string, args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout.trim(), stderr: (stderr || (error?.message ?? "")).trim() });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? "");
  });
}

export const COMMIT_ID = /^[0-9a-f]{7,40}$/;
const MAX_DIFF_CHARS = 40_000;

// What a task changed, for its review: the diff from the commit it started from (else HEAD), and
// the short status, which also lists new files the diff leaves out.
export async function workChanges(repo: string, base: string | null): Promise<{ diff: string; status: string }> {
  const from = base && COMMIT_ID.test(base) ? base : "HEAD";
  const [diff, status] = await Promise.all([git(repo, ["diff", from]), git(repo, ["status", "--short"])]);
  const text = diff.ok ? diff.stdout : `(No diff available: ${diff.stderr || "git diff failed"})`;
  return {
    diff: text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (cut at ${MAX_DIFF_CHARS} characters; read the files for the rest)` : text,
    status: status.ok ? status.stdout : "",
  };
}

// Commits just these files, leaving whatever else agents have changed in the tree alone. The
// message can hold an agent's words, so it goes through stdin like prompts do.
export async function commitFiles(repo: string, files: string[], message: string): Promise<{ ok: boolean; error: string | null }> {
  const add = await git(repo, ["add", "--", ...files]);
  if (!add.ok) return { ok: false, error: add.stderr };
  // A machine without a git identity still gets its design history.
  const identity = (await git(repo, ["config", "user.email"])).stdout ? [] : ["-c", "user.name=AgentDashboard", "-c", "user.email=agentdashboard@localhost"];
  const commit = await git(repo, [...identity, "commit", "-F", "-", "--only", "--", ...files], message);
  if (!commit.ok && /nothing to commit|no changes added/i.test(commit.stderr + commit.stdout)) return { ok: true, error: null };
  return { ok: commit.ok, error: commit.ok ? null : commit.stderr };
}

export type RepoCheck = { ok: true; path: string } | { ok: false; error: string; canInit: boolean };

// A project points at the top of a git repository. Agents run there, and later phases branch and
// merge in it, so a plain folder or a subfolder of a repo is refused.
export async function checkRepo(repoPath: string): Promise<RepoCheck> {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) return { ok: false, error: `The folder does not exist: ${resolved}`, canInit: true };
  if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: `Not a folder: ${resolved}`, canInit: false };
  const top = await git(resolved, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (/not a git repository/i.test(top.stderr)) return { ok: false, error: `Not a git repository: ${resolved}`, canInit: true };
    return { ok: false, error: `git failed: ${top.stderr || "is git installed and on PATH?"}`, canInit: false };
  }
  // Windows paths compare without case; git prints them with forward slashes, path.resolve fixes that.
  const real = (p: string) => fs.realpathSync.native(path.resolve(p));
  const same = process.platform === "win32" ? real(top.stdout).toLowerCase() === real(resolved).toLowerCase() : real(top.stdout) === real(resolved);
  if (!same) {
    return { ok: false, error: `This folder is inside the repository ${path.resolve(top.stdout)}. Choose the repository's top folder.`, canInit: false };
  }
  return { ok: true, path: resolved };
}

// Creates the folder if needed and runs `git init` with main as the first branch.
export async function initRepo(repoPath: string): Promise<RepoCheck> {
  const resolved = path.resolve(repoPath);
  fs.mkdirSync(resolved, { recursive: true });
  const result = await git(resolved, ["init", "-b", "main"]);
  if (!result.ok) return { ok: false, error: `git init failed: ${result.stderr}`, canInit: false };
  return checkRepo(resolved);
}
