import { MODEL_PRESETS, type Usage } from "@ad/shared";

export function modelLabel(id: string): string {
  return MODEL_PRESETS.find((m) => m.id === id)?.label ?? id;
}

export function cost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function usageLine(u: Usage): string {
  const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${tokens(input)} in · ${tokens(u.outputTokens)} out`;
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(startIso: string, endIso: string | null, now = Date.now()): string {
  const ms = (endIso ? new Date(endIso).getTime() : now) - new Date(startIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
