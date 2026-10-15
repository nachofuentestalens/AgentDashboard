import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Effort } from "@ad/shared";
import type { CliSpec } from "./claude.ts";

export const FAKE_CODEX = fileURLToPath(new URL("../fake/fake-codex.mjs", import.meta.url));

export const CODEX_CLI: CliSpec = {
  name: "Codex",
  executables: { win32: ["codex.exe", "codex.cmd"], other: ["codex"] },
  npmPackage: ["@openai", "codex"],
  entries: [path.join("bin", "codex.js")],
  fake: FAKE_CODEX,
};

export interface CodexArgs {
  // Null: the model in ~/.codex/config.toml.
  model: string | null;
  effort: Effort;
  // Set: continue that thread with `exec resume`. Codex picks a new thread's id itself and reports
  // it in its first event.
  resumeId: string | null;
  sandbox: "read-only" | "workspace-write";
  // Folders writable besides the working directory, for a department owning several.
  writableRoots: string[];
}

// TOML literal strings take a path as is, backslashes included; they cannot hold a quote.
const tomlPath = (p: string) => (/['\r\n]/.test(p) ? null : `'${p}'`);

// `codex exec --json` with settings as -c overrides. The prompt goes through stdin ("-"), like
// Claude's, never as an argument.
export function buildCodexArgs(a: CodexArgs): string[] {
  const args = ["exec"];
  if (a.resumeId) args.push("resume", a.resumeId);
  args.push("--json");
  if (a.model) args.push("-m", a.model);
  args.push("-c", `model_reasoning_effort="${a.effort}"`, "-c", `sandbox_mode="${a.sandbox}"`, "-c", 'approval_policy="never"');
  const roots = a.writableRoots.map(tomlPath).filter((r): r is string => r !== null);
  if (a.sandbox === "workspace-write" && roots.length) args.push("-c", `sandbox_workspace_write.writable_roots=[${roots.join(", ")}]`);
  args.push("-");
  return args;
}
