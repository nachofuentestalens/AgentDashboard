import type { AgentEvent } from "./events.ts";
import { emptyUsage, type Usage } from "./models.ts";

// Tool output can be huge (a file dump, a long build log). The transcript only needs enough to read.
export const MAX_TOOL_RESULT_CHARS = 20_000;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function truncate(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
}

export function parseUsage(v: unknown): Usage {
  if (!isObject(v)) return emptyUsage();
  return {
    inputTokens: num(v.input_tokens),
    outputTokens: num(v.output_tokens),
    cacheReadTokens: num(v.cache_read_input_tokens),
    cacheWriteTokens: num(v.cache_creation_input_tokens),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && part.type === "text" ? str(part.text) : isObject(part) && part.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// One line of `claude -p --output-format stream-json` output → zero or more events.
// Unknown or malformed lines yield nothing: the CLI adds event types over time and a new one
// must never break a run.
export function parseClaudeLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isObject(data)) return [];
  // Subagent (Task tool) internals carry their parent's tool id; the parent's tool_use and
  // tool_result already summarise them.
  if (typeof data.parent_tool_use_id === "string" && data.parent_tool_use_id) return [];

  switch (data.type) {
    case "system":
      if (data.subtype === "init") return [{ kind: "init", sessionId: str(data.session_id), model: str(data.model) }];
      return [];

    case "stream_event": {
      const ev = data.event;
      if (!isObject(ev)) return [];
      if (ev.type === "message_start") return [{ kind: "message_start" }];
      if (ev.type === "content_block_delta" && isObject(ev.delta) && ev.delta.type === "text_delta") {
        const text = str(ev.delta.text);
        return text ? [{ kind: "text_delta", text }] : [];
      }
      return [];
    }

    case "assistant": {
      const message = data.message;
      if (!isObject(message) || !Array.isArray(message.content)) return [];
      const events: AgentEvent[] = [];
      for (const block of message.content) {
        if (!isObject(block)) continue;
        if (block.type === "text" && str(block.text)) events.push({ kind: "text", text: str(block.text) });
        else if (block.type === "tool_use") events.push({ kind: "tool_use", id: str(block.id), name: str(block.name), input: block.input ?? {} });
      }
      return events;
    }

    case "user": {
      const message = data.message;
      if (!isObject(message) || !Array.isArray(message.content)) return [];
      const events: AgentEvent[] = [];
      for (const block of message.content) {
        if (isObject(block) && block.type === "tool_result") {
          events.push({
            kind: "tool_result",
            toolUseId: str(block.tool_use_id),
            content: truncate(toolResultText(block.content)),
            isError: block.is_error === true,
          });
        }
      }
      return events;
    }

    case "result":
      return [
        {
          kind: "result",
          isError: data.is_error === true || (typeof data.subtype === "string" && data.subtype !== "success"),
          text: str(data.result),
          sessionId: typeof data.session_id === "string" ? data.session_id : null,
          costUsd: num(data.total_cost_usd),
          usage: parseUsage(data.usage),
          durationMs: num(data.duration_ms),
          numTurns: num(data.num_turns),
        },
      ];

    case "rate_limit_event": {
      const event = claudeRateLimit(data.rate_limit_info);
      return event ? [event] : [];
    }

    default:
      return [];
  }
}

// Unix seconds, milliseconds or an ISO string → ISO, else null.
export function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

const percent = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  // Utilization comes as a fraction; percentages above 1 are already scaled.
  return Math.min(100, v <= 1 ? v * 100 : v);
};

// Claude Code reports each limit window it checked. Field names have changed between CLI versions,
// so every one is optional; a window it does not name is ignored.
function claudeRateLimit(info: unknown): AgentEvent | null {
  if (!isObject(info)) return null;
  const type = str(info.rateLimitType ?? info.rate_limit_type);
  const window = type === "five_hour" ? "session" : type.startsWith("seven_day") ? "weekly" : null;
  if (!window) return null;
  return {
    kind: "rate_limit",
    window,
    usedPercent: percent(info.utilization ?? info.usedPercent ?? info.used_percent),
    resetsAt: toIso(info.resetsAt ?? info.resets_at),
    rejected: info.status === "rejected",
  };
}

// Codex reports `rate_limits: { primary, secondary }` with its token counts; where it sits in the
// event has moved between versions, so it is looked for at the top level and one level down.
export function codexRateLimits(data: Record<string, unknown>, now = Date.now()): AgentEvent[] {
  const holder = [data, ...Object.values(data)].find((v) => isObject(v) && isObject(v.rate_limits)) as Json | undefined;
  if (!holder) return [];
  const limits = holder.rate_limits as Json;
  const events: AgentEvent[] = [];
  for (const [name, fallback] of [
    ["primary", "session"],
    ["secondary", "weekly"],
  ] as const) {
    const w = limits[name];
    if (!isObject(w)) continue;
    const minutes = num(w.window_minutes);
    const resetsIn = num(w.resets_in_seconds);
    events.push({
      kind: "rate_limit",
      window: minutes ? (minutes >= 24 * 60 ? "weekly" : "session") : fallback,
      // Always a percentage here, so 1 means 1%, not a full window.
      usedPercent: typeof w.used_percent === "number" && w.used_percent >= 0 ? Math.min(100, w.used_percent) : null,
      resetsAt: toIso(w.resets_at) ?? (resetsIn ? new Date(now + resetsIn * 1000).toISOString() : null),
      rejected: false,
    });
  }
  return events;
}
