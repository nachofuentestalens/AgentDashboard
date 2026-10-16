import { z } from "zod";
import { DEFAULT_PRIORITY, MAX_PRIORITY, MIN_PRIORITY } from "./models.ts";

// Agents talk to the dashboard by ending a reply with fenced blocks:
//   ```proposal  {"docPath": "design/game/combat.md", "rationale": "...", "body": "# Combat\n..."}
//   ```task      {"role": "Gameplay Programmer", "title": "...", "prompt": "...", "priority": 7, "emergency": false}
//   ```question  Plain text, or {"question": "..."}
//   ```step      {"state": "done", "summary": "...", "next": "..."}   (role tasks: how far the work got)
//   ```review    {"verdict": "pass", "findings": ["path:line problem"]}   (review runs only)
//   ```plan      {"steps": ["First step", "Second step"]}   (role tasks: the steps still to do)
// A block that does not parse is reported back, never fatal: the reply itself still counts.

export type ReplyBlock =
  | { type: "proposal"; docPath: string; rationale: string; body: string }
  | { type: "task"; role: string; title: string; prompt: string; priority: number; emergency: boolean }
  | { type: "question"; question: string }
  | { type: "step"; state: "done" | "partial" | "complete"; summary: string; next: string | null }
  | { type: "review"; verdict: "pass" | "changes"; findings: string[] }
  | { type: "plan"; steps: string[] }
  | { type: "invalid"; lang: string; error: string };

const plan = z.object({ steps: z.array(z.string().trim().min(1).max(200)).min(1).max(30) });

const review = z.object({
  verdict: z.enum(["pass", "changes"]),
  findings: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
});

const step = z.object({
  state: z.enum(["done", "partial", "complete"]),
  summary: z.string().trim().max(2000).default(""),
  next: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((s) => s || null),
});

const proposal = z.object({
  docPath: z.string().trim().min(1).max(300),
  rationale: z.string().trim().max(5000).default(""),
  body: z.string().max(500_000),
});

const task = z.object({
  role: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100_000),
  // Agents sometimes write 7.5 or "8"; round and clamp rather than refuse.
  priority: z.coerce
    .number()
    .catch(DEFAULT_PRIORITY)
    .transform((n) => Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.round(n))))
    .default(DEFAULT_PRIORITY),
  emergency: z.boolean().default(false),
});

// The closing fence must match the opening one; JSON strings cannot hold a raw newline, so a line
// that starts with a fence always ends the block.
const FENCE = /^(`{3,}|~{3,})[ \t]*(proposal|task|question|step|review|plan)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "block"}: ${i.message}`).join("; ");

export function parseReplyBlocks(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  for (const match of text.matchAll(FENCE)) {
    const lang = match[2]!;
    const raw = match[3]!.trim();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      if (lang === "question" && raw) blocks.push({ type: "question", question: raw });
      else blocks.push({ type: "invalid", lang, error: "The block is not valid JSON." });
      continue;
    }
    if (lang === "question") {
      const q = typeof data === "string" ? data : typeof (data as { question?: unknown })?.question === "string" ? (data as { question: string }).question : "";
      if (q.trim()) blocks.push({ type: "question", question: q.trim() });
      else blocks.push({ type: "invalid", lang, error: 'A question block needs text or {"question": "..."}.' });
      continue;
    }
    const schema = { proposal, step, review, plan, task }[lang as "proposal" | "step" | "review" | "plan" | "task"];
    const parsed = schema.safeParse(data);
    if (!parsed.success) blocks.push({ type: "invalid", lang, error: issues(parsed.error) });
    else blocks.push({ type: lang, ...parsed.data } as ReplyBlock);
  }
  return blocks;
}
