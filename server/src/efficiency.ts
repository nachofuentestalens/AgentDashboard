import { z } from "zod";
import type { Usage } from "@ad/shared";

export const totalTokens = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;

// Agents often list files or steps as arrays; accept those as lines instead of failing the handoff.
const field = z.preprocess(
  (v) => (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number") ? v.map((x) => `- ${x}`).join("\n") : v),
  z.string().trim().min(1),
);
const handoff = z.object({ goal: field, constraints: field, files: field, completed: field, verification: field, remaining: field }).strict();

export const HANDOFF_REQUEST = `Prepare a compact context handoff using only the conversation you already have. Do not call tools, edit files, delegate, or continue implementation. Preserve user requirements and corrections. Distinguish verified facts from assumptions and list unfinished work. Return one fenced context-handoff JSON block with six string fields: goal, constraints, files, completed, verification, remaining. Use at most 6,000 characters in the block. This summary will be reviewed before a fresh session starts.`;

export function extractHandoff(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = [...normalized.matchAll(/```[ \t]*context-handoff[^\n]*\n([\s\S]*?)\n[ \t]*```/g)].map((m) => m[1]!);
  // Some agents (Codex in particular) answer with the bare JSON object and no fence.
  if (blocks.length === 0 && /^\{[\s\S]*\}$/.test(normalized.trim())) blocks.push(normalized.trim());
  // Only the rendered summary is capped: indentation in the JSON should not reject a handoff.
  if (blocks.length !== 1) return null;
  try {
    const parsed = handoff.parse(JSON.parse(blocks[0]!));
    const summary = Object.entries(parsed)
      .map(([key, value]) => `${key.toUpperCase()}\n${value}`)
      .join("\n\n");
    return summary.length <= 6000 ? summary : null;
  } catch {
    return null;
  }
}

export function efficiencyInstructions(tokens: number | null, tools: number | null): string {
  return `<efficiency>\nWork in focused phases. Read a small project map (CLAUDE.md or AGENTS.md if present), then only relevant files. Prefer existing concise architectural notes over rediscovery; update relevant notes when architecture changes. Do not launch extra agents or speculative work. Use bounded output and focused checks; do not repeat successful checks without a relevant change.\nRemaining task allowance: ${tokens === null ? "unlimited" : Math.max(0, tokens)} reported tokens (including cache), ${tools === null ? "unlimited" : Math.max(0, tools)} tool calls. These are approximate checkpoints, not billing limits. Leave room for verification and a handoff; end the turn at a safe phase boundary before exhausting the allowance.\nIf more work remains at a completed phase boundary, end with one fenced context-handoff JSON block containing six nonempty string fields: goal, constraints, files, completed, verification, remaining (6,000 characters maximum). Include user constraints, relevant paths, completed checks and unresolved issues; omit raw logs. Do not emit a handoff when the task is fully complete.\n</efficiency>`;
}
