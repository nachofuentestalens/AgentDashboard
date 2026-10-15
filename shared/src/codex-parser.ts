import type { AgentEvent } from "./events.ts";
import { truncate } from "./parser.ts";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// The tool row an item shows as, or null for items that are not tool calls.
function toolOf(item: Json): { name: string; input: unknown } | null {
  switch (item.type) {
    case "command_execution":
      return { name: "Shell", input: { command: str(item.command) } };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      return { name: "Edit", input: { path: changes.map((c) => str(c.path)).join(", "), changes } };
    }
    case "mcp_tool_call":
      return { name: `${str(item.server)}.${str(item.tool)}`, input: item.arguments ?? {} };
    case "web_search":
      return { name: "WebSearch", input: { query: str(item.query) } };
    default:
      return null;
  }
}

function resultOf(item: Json): { content: string; isError: boolean } {
  switch (item.type) {
    case "command_execution":
      return { content: truncate(str(item.aggregated_output)), isError: typeof item.exit_code === "number" && item.exit_code !== 0 };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      return { content: changes.map((c) => `${str(c.kind)} ${str(c.path)}`).join("\n"), isError: item.status === "failed" };
    }
    case "mcp_tool_call": {
      const error = isObject(item.error) ? str(item.error.message) : "";
      return { content: truncate(error || JSON.stringify(item.result ?? "")), isError: !!error || item.status === "failed" };
    }
    default:
      return { content: "", isError: item.status === "failed" };
  }
}

// `codex exec --json` output → the same events Claude's stream produces. One parser per run: Codex
// reports the thread id, the text and the usage in separate events, and a tool item may arrive
// completed without having been announced as started. Unknown lines yield nothing.
export function createCodexParser(): (line: string) => AgentEvent[] {
  let threadId: string | null = null;
  let lastText = "";
  const started = new Set<string>();

  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObject(data)) return [];

    switch (data.type) {
      case "thread.started":
        threadId = str(data.thread_id) || null;
        return [{ kind: "init", sessionId: threadId ?? "", model: "" }];

      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = data.item;
        if (!isObject(item)) return [];
        const id = str(item.id);
        if (item.type === "agent_message") {
          if (data.type !== "item.completed") return [];
          lastText = str(item.text);
          return lastText ? [{ kind: "message_start" }, { kind: "text", text: lastText }] : [];
        }
        if (item.type === "error") return data.type === "item.completed" ? [{ kind: "stderr", text: str(item.message) }] : [];
        const tool = toolOf(item);
        if (!tool) return [];
        const events: AgentEvent[] = [];
        if (!started.has(id)) {
          started.add(id);
          events.push({ kind: "tool_use", id, name: tool.name, input: tool.input });
        }
        if (data.type === "item.completed") events.push({ kind: "tool_result", toolUseId: id, ...resultOf(item) });
        return events;
      }

      case "turn.completed": {
        const usage = isObject(data.usage) ? data.usage : {};
        const cached = num(usage.cached_input_tokens);
        return [
          {
            kind: "result",
            isError: false,
            text: lastText,
            sessionId: threadId,
            // Codex reports tokens, not money (ChatGPT plans have no per-run price).
            costUsd: 0,
            usage: {
              inputTokens: Math.max(0, num(usage.input_tokens) - cached),
              outputTokens: num(usage.output_tokens),
              cacheReadTokens: cached,
              cacheWriteTokens: num(usage.cache_write_input_tokens),
            },
            durationMs: 0,
            numTurns: 1,
          },
        ];
      }

      case "turn.failed": {
        const error = isObject(data.error) ? str(data.error.message) : "";
        return [
          {
            kind: "result",
            isError: true,
            text: error || "Codex could not finish the turn.",
            sessionId: threadId,
            costUsd: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            durationMs: 0,
            numTurns: 1,
          },
        ];
      }

      // Also sent for stream hiccups Codex retries by itself; a real failure ends in turn.failed.
      case "error":
        return [{ kind: "stderr", text: str(data.message) || "Codex reported an error." }];

      default:
        return [];
    }
  };
}
