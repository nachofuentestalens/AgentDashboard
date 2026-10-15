import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs, findOnPath, resolveCmdShim, resolveLauncher } from "../src/claude.ts";

const base = { model: "claude-opus-5-5", effort: "medium" as const, sessionId: "abc", allowedTools: ["Bash(git:*)"], systemPrompt: "ctx" };

describe("buildArgs", () => {
  it("starts a new session with an id we chose, and resumes it later", () => {
    const first = buildArgs({ ...base, resume: false, canEdit: true });
    expect(first.slice(0, 10)).toEqual(
      ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "claude-opus-5-5", "--effort", "medium"].concat(
        "--session-id",
      ),
    );
    expect(first).toContain("abc");
    expect(first).not.toContain("--resume");
    const later = buildArgs({ ...base, resume: true, canEdit: true });
    expect(later.join(" ")).toContain("--resume abc");
    expect(later).not.toContain("--session-id");
  });

  it("lets a writing task edit and run only the allowed commands", () => {
    const args = buildArgs({ ...base, resume: false, canEdit: true }).join(" ");
    expect(args).toContain("--permission-mode acceptEdits --allowedTools Bash(git:*)");
    expect(args).not.toContain("--disallowedTools");
  });

  it("keeps a read-only task away from edits and shells", () => {
    const args = buildArgs({ ...base, resume: false, canEdit: false }).join(" ");
    expect(args).toContain("--permission-mode default");
    expect(args).toContain("--disallowedTools Edit Write NotebookEdit Bash PowerShell");
    expect(args).not.toContain("Bash(git:*)");
  });

  it("ends with the appended system prompt; the user prompt goes through stdin", () => {
    expect(buildArgs({ ...base, resume: false, canEdit: true }).at(-1)).toBe("ctx");
  });
});

describe("finding Claude Code", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-claude-"));

  it("follows an npm .cmd shim to the script it starts", () => {
    const dir = tmp();
    const cli = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    const launcher = resolveCmdShim(shim);
    expect(launcher.command).toBe(process.execPath);
    expect(launcher.prefix).toEqual([cli]);
  });

  it("explains a shim whose target is missing", () => {
    const dir = tmp();
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, "@echo off\r\n");
    expect(() => resolveCmdShim(shim)).toThrow(/Set the Claude Code path/);
  });

  it("searches PATH, preferring claude.exe on Windows", () => {
    const a = tmp();
    const b = tmp();
    fs.writeFileSync(path.join(a, "claude.cmd"), "");
    fs.writeFileSync(path.join(b, "claude.exe"), "");
    expect(findOnPath({ PATH: [a, b].join(path.delimiter), USERPROFILE: a }, "win32")).toBe(path.join(b, "claude.exe"));
    fs.writeFileSync(path.join(a, "claude"), "");
    expect(findOnPath({ PATH: a }, "linux")).toBe(path.join(a, "claude"));
    expect(findOnPath({ PATH: b }, "linux")).toBeNull();
  });

  it("uses the bundled fake agent for demos, and rejects a configured path that is missing", () => {
    expect(resolveLauncher("fake").display).toMatch(/fake/);
    expect(() => resolveLauncher(path.join(tmp(), "nope.exe"))).toThrow(/does not exist/);
  });
});
