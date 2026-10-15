import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout.trim(), stderr: (stderr || (error?.message ?? "")).trim() });
    });
  });
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
