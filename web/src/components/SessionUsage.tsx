import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, keys } from "../api.ts";

function resetHint(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "Reset time unknown";
  const reset = new Date(resetsAt);
  const minutes = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return `Resets in ${hours ? `${hours}h ` : ""}${minutes % 60}m (${reset.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })})`;
}

export function SessionUsage() {
  const view = useQuery({ queryKey: keys.coordinator, queryFn: api.coordinator, refetchInterval: 30_000 });

  return (
    <section aria-label="Session usage" className="shrink-0 space-y-1 border-t border-ink-800 p-3">
      <h2 className="px-1 text-[11px] font-semibold tracking-wider text-ink-400 uppercase">Session remaining</h2>
      {(["claude", "codex"] as const).map((provider) => {
        const session = view.data?.providers.find((p) => p.provider === provider)?.session;
        const used = session?.usedPercent;
        const remaining = used == null ? null : Math.max(0, Math.min(100, 100 - Math.round(used)));
        const label = provider === "claude" ? "Claude" : "Codex";
        const value = remaining === null ? (view.isPending ? "Loading…" : "Unknown") : `${remaining}% left`;
        const hint = view.isError ? "Usage could not be refreshed. " : "";
        const color =
          session?.level === "exhausted" || session?.level === "reserve"
            ? "text-red-300"
            : session?.level === "conserve"
              ? "text-amber-300"
              : remaining === null
                ? "text-ink-400"
                : "text-emerald-300";

        return (
          <Link
            key={provider}
            to="/coordinator"
            aria-label={`${label} session: ${value}`}
            aria-describedby={`session-reset-${provider}`}
            className="group relative flex items-center justify-between rounded-md px-1 py-1 text-xs text-ink-200 hover:bg-ink-800 focus-visible:outline focus-visible:outline-gold"
          >
            <span>{label}</span>
            <span className={`font-medium tabular-nums ${color}`}>{value}</span>
            <span
              id={`session-reset-${provider}`}
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-0 z-50 mb-1 hidden w-52 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs font-normal text-ink-200 shadow-lg group-hover:block group-focus-visible:block"
            >
              {hint}
              {resetHint(session?.resetsAt)}
              {session?.source === "estimate" ? ". Usage is estimated." : session?.source === "reset" ? ". Reset since the last reading." : ""}
            </span>
          </Link>
        );
      })}
    </section>
  );
}
