import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Effort } from "@ad/shared";
import type { EditRules } from "./folders.ts";

// How to start an agent CLI: the program and the arguments that come before ours.
export interface Launcher {
  command: string;
  prefix: string[];
  // What the settings page shows: the file that was found.
  display: string;
}

export const FAKE_CLAUDE = fileURLToPath(new URL("../fake/fake-claude.mjs", import.meta.url));

// Where an agent CLI lives once installed: its executables on PATH, and the npm package its .cmd
// shim starts.
export interface CliSpec {
  name: string;
  executables: { win32: string[]; other: string[] };
  npmPackage: string[];
  entries: string[];
  fake: string;
}

export const CLAUDE_CLI: CliSpec = {
  name: "Claude Code",
  executables: { win32: ["claude.exe", "claude.cmd"], other: ["claude"] },
  npmPackage: ["@anthropic-ai", "claude-code"],
  entries: ["cli.js", path.join("bin", "claude.exe"), path.join("bin", "claude")],
  fake: FAKE_CLAUDE,
};

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const nodeScript = (script: string): Launcher => ({ command: process.execPath, prefix: [script], display: script });

// npm installs `claude.cmd` / `codex.cmd`, batch shims. Node refuses to spawn batch files without a
// shell, and going through cmd.exe would expose our arguments to its parsing, so start what the
// shim points at.
export function resolveCmdShim(cmdPath: string, spec: CliSpec = CLAUDE_CLI): Launcher {
  const dir = path.dirname(cmdPath);
  const candidates: string[] = [];
  try {
    const text = fs.readFileSync(cmdPath, "utf8");
    for (const match of text.matchAll(/%~?dp0%?\\([^"%\r\n]+\.(?:js|mjs|cjs|exe))/gi)) candidates.push(path.join(dir, match[1]!));
  } catch {
    // Unreadable shim: fall through to the usual package layout.
  }
  const pkg = path.join(dir, "node_modules", ...spec.npmPackage);
  candidates.push(...spec.entries.map((entry) => path.join(pkg, entry)));
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    if (/\.(m|c)?js$/i.test(candidate)) return nodeScript(candidate);
    return { command: candidate, prefix: [], display: candidate };
  }
  throw new Error(`Found ${cmdPath}, but not the program it starts. Set the ${spec.name} path in Settings to the executable or to the package's script.`);
}

function fromPath(file: string, spec: CliSpec): Launcher {
  if (/\.(m|c)?js$/i.test(file)) return nodeScript(file);
  if (/\.(cmd|bat)$/i.test(file)) return resolveCmdShim(file, spec);
  return { command: file, prefix: [], display: file };
}

export function findOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, spec: CliSpec = CLAUDE_CLI): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const names = platform === "win32" ? spec.executables.win32 : spec.executables.other;
  // Native installers put their executable here; it is not always on PATH for GUI-started shells.
  if (platform === "win32") dirs.push(path.join(env.USERPROFILE || os.homedir(), ".local", "bin"));
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// configured: the Settings value. Empty = search PATH. "fake" = the bundled stand-in used for tests
// and demos, which needs no account and spends nothing.
export function resolveLauncher(configured: string, env: NodeJS.ProcessEnv = process.env, spec: CliSpec = CLAUDE_CLI): Launcher {
  const value = configured.trim();
  if (value === "fake" || env.AGENT_DASHBOARD_FAKE_CLAUDE === "1") return { ...nodeScript(spec.fake), display: "fake (demo agent)" };
  if (value) {
    if (!isFile(value)) throw new Error(`The ${spec.name} path in Settings does not exist: ${value}`);
    return fromPath(value, spec);
  }
  const found = findOnPath(env, process.platform, spec);
  if (!found) throw new Error(`${spec.name} was not found on PATH. Install it, or set its full path in Settings.`);
  return fromPath(found, spec);
}

export function checkCli(
  configured: string,
  spec: CliSpec = CLAUDE_CLI,
): Promise<{ ok: boolean; command: string | null; version: string | null; error: string | null }> {
  let launcher: Launcher;
  try {
    launcher = resolveLauncher(configured, process.env, spec);
  } catch (error) {
    return Promise.resolve({ ok: false, command: null, version: null, error: (error as Error).message });
  }
  return new Promise((resolve) => {
    execFile(launcher.command, [...launcher.prefix, "--version"], { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, command: launcher.display, version: null, error: (stderr || error.message).trim() });
      else resolve({ ok: true, command: launcher.display, version: stdout.trim(), error: null });
    });
  });
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell"];

export interface RunArgs {
  model: string;
  effort: Effort;
  // First turn: --session-id with a new id. Later turns: --resume with the same id.
  sessionId: string;
  resume: boolean;
  canEdit: boolean;
  // Owner chats can use the machine's tools without an interactive approval prompt.
  fullAccess?: boolean;
  allowedTools: string[];
  systemPrompt: string;
  // A role's preamble: long and written by people, so it goes in a file rather than an argument.
  systemPromptFile?: string;
  // A role's department folders; without them a writing run may edit anywhere.
  editRules?: EditRules | null;
}

// The prompt itself goes through stdin, never through the arguments.
export function buildArgs(a: RunArgs): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", a.model, "--effort", a.effort];
  args.push(a.resume ? "--resume" : "--session-id", a.sessionId);
  if (a.canEdit && a.fullAccess) {
    args.push("--permission-mode", "bypassPermissions");
  } else if (a.canEdit) {
    // Headless runs cannot ask for permission: anything not allowed here is refused. A department
    // confined to its folders gets no blanket acceptEdits, only edit rules for those folders.
    if (a.editRules?.mode === "default") args.push("--permission-mode", "default", "--allowedTools", ...a.editRules.allow, ...a.allowedTools);
    else {
      args.push("--permission-mode", "acceptEdits");
      if (a.allowedTools.length > 0) args.push("--allowedTools", ...a.allowedTools);
    }
    if (a.editRules?.deny.length) args.push("--disallowedTools", ...a.editRules.deny);
  } else {
    args.push("--permission-mode", "default", "--allowedTools", ...READ_ONLY_TOOLS, "--disallowedTools", ...WRITE_TOOLS);
  }
  if (a.systemPromptFile) args.push("--append-system-prompt-file", a.systemPromptFile);
  else if (a.systemPrompt) args.push("--append-system-prompt", a.systemPrompt);
  return args;
}

export function systemPrompt(projectName: string, canEdit: boolean, fullAccess = false): string {
  return [
    `You are working on the game project "${projectName}" through AgentDashboard, a local dashboard the developer uses to direct agents.`,
    "Read only relevant files, bound command output, avoid repeating successful checks, and keep replies concise.",
    "The developer reads your replies in the dashboard, rendered as Markdown. Nobody can approve permission prompts while you run:",
    canEdit
      ? fullAccess
        ? "this editable owner chat has full filesystem, command and network access. Carry out the owner's authorized work without permission prompts; respect their task scope and repository/worktree instructions."
        : "file edits are allowed, and only the pre-approved commands will run. If you need a command that is refused, say which one and why."
      : "this conversation is read-only. Investigate and explain, but do not try to change files.",
  ].join(" ");
}
