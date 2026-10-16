import type { AgentEvent } from "./events.ts";

// What the run viewer draws: the run's events folded into an ordered list of text and tool items.
export type TranscriptItem =
  | { type: "text"; text: string; streaming: boolean }
  | { type: "tool"; id: string; name: string; input: unknown; result: string | null; isError: boolean }
  | { type: "error"; message: string }
  | { type: "notice"; level: "info" | "warn"; text: string };

export interface Transcript {
  items: TranscriptItem[];
  done: boolean;
}

export const emptyTranscript = (): Transcript => ({ items: [], done: false });

// Pure and incremental: the viewer applies events one at a time as they arrive, and replaying the
// stored JSONL produces the same transcript.
export function applyEvent(t: Transcript, e: AgentEvent): Transcript {
  const items = t.items.slice();
  const last = items[items.length - 1];
  switch (e.kind) {
    case "text_delta":
      if (last?.type === "text" && last.streaming) items[items.length - 1] = { ...last, text: last.text + e.text };
      else items.push({ type: "text", text: e.text, streaming: true });
      break;
    case "text":
      // The full block supersedes the deltas streamed for it.
      if (last?.type === "text" && last.streaming) items[items.length - 1] = { type: "text", text: e.text, streaming: false };
      else items.push({ type: "text", text: e.text, streaming: false });
      break;
    case "message_start":
      if (last?.type === "text" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      break;
    case "tool_use":
      if (last?.type === "text" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      items.push({ type: "tool", id: e.id, name: e.name, input: e.input, result: null, isError: false });
      break;
    case "tool_result": {
      const index = items.findIndex((i) => i.type === "tool" && i.id === e.toolUseId);
      const item = items[index];
      if (item?.type === "tool") items[index] = { ...item, result: e.content, isError: e.isError };
      break;
    }
    case "result":
      if (e.isError && e.text) items.push({ type: "error", message: e.text });
      return { items: items.map((i) => (i.type === "text" && i.streaming ? { ...i, streaming: false } : i)), done: true };
    case "error":
      items.push({ type: "error", message: e.message });
      break;
    case "notice":
      items.push({ type: "notice", level: e.level, text: e.text });
      break;
    case "init":
    case "rate_limit":
    case "stderr":
      return t;
  }
  return { items, done: t.done };
}

export function buildTranscript(events: AgentEvent[]): Transcript {
  return events.reduce(applyEvent, emptyTranscript());
}

// The assistant's reply as one string: the text blocks after the last tool call. Earlier text is
// narration between tool calls; the final stretch is the answer.
export function finalText(events: AgentEvent[]): string {
  const items = buildTranscript(events).items;
  let lastTool = -1;
  items.forEach((item, i) => {
    if (item.type === "tool") lastTool = i;
  });
  const tail = items.slice(lastTool + 1).filter((i) => i.type === "text");
  if (tail.length > 0) return tail.map((i) => (i.type === "text" ? i.text : "")).join("\n\n");
  const any = items.filter((i) => i.type === "text");
  return any.map((i) => (i.type === "text" ? i.text : "")).join("\n\n");
}

// One-line summary of a tool call's input for the collapsed row.
export function describeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const i = input as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const value =
    pick("command") || pick("file_path") || pick("path") || pick("pattern") || pick("url") || pick("query") || pick("description") || pick("prompt");
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}
