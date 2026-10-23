import fs from "node:fs";
import path from "node:path";
import type { Inbox, Project, ProviderQuotaView } from "@ad/shared";
import { inboxKeys } from "@ad/shared";
import { projectHealth, type Health } from "./health.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";

// Owner alerts sent off the machine (Telegram) when agents stop making progress: a stalled queue,
// failing or stuck tasks, a provider out of quota, a steward escalation or an agent's question.
// See docs/NOTIFICATIONS.md. The rules are pure; the service polls and remembers what it sent.

export const NOTIFY_INTERVAL_MS = 60_000;
const MAX_MESSAGE = 3800;
const PROVIDER_NAME = { claude: "Claude", codex: "Codex" } as const;

export interface OwnerAlert {
  // Stable while the problem lasts, so it is sent once.
  key: string;
  text: string;
  // Sent when the alert's key goes away; only for problems whose end is worth hearing about.
  recovery?: string;
}

export interface AlertInput {
  projects: { project: Project; health: Health }[];
  providers: ProviderQuotaView[];
  inbox: Pick<Inbox, "alerts" | "questions">;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

// The detail lines that explain a concern; advice addressed to the steward is left out.
function reasonLines(detail: string): string[] {
  return detail
    .split("\n")
    .filter((l) => l.startsWith("- ") || l.startsWith("Error:") || l.startsWith("Next step:"))
    .slice(0, 3)
    .map((l) => clip(l, 240));
}

export function ownerAlerts({ projects, providers, inbox }: AlertInput): OwnerAlert[] {
  const out: OwnerAlert[] = [];
  for (const p of providers) {
    if (p.level !== "reserve" && p.level !== "exhausted") continue;
    const name = PROVIDER_NAME[p.provider];
    out.push({ key: `provider:${p.provider}:${p.level}`, text: `${name} agents are waiting: ${p.reason}`, recovery: `${name} agents can work again.` });
  }
  for (const { project, health } of projects) {
    for (const c of health.concerns) {
      out.push({ key: `health:${project.id}:${c.key}`, text: [`${project.name}: ${c.title}`, ...reasonLines(c.detail)].join("\n") });
    }
  }
  for (const a of inbox.alerts) out.push({ key: `alert:${a.projectId}:${a.key}`, text: `${a.projectName}: ${a.title}` });
  for (const q of inbox.questions) {
    out.push({ key: inboxKeys.question(q.task), text: [`Question from "${q.task.title}":`, clip(q.task.question ?? "", 400)].join("\n") });
  }
  return out;
}

// What to send now: alerts not sent before, and recoveries of sent alerts that went away.
export function alertChanges(sent: ReadonlyMap<string, string | null>, alerts: OwnerAlert[]): { messages: string[]; next: Map<string, string | null> } {
  const next = new Map(alerts.map((a) => [a.key, a.recovery ?? null]));
  const fresh = alerts.filter((a) => !sent.has(a.key)).map((a) => `⚠️ ${a.text}`);
  const recovered = [...sent].flatMap(([key, recovery]) => (recovery && !next.has(key) ? [`✅ ${recovery}`] : []));
  return { messages: [...fresh, ...recovered], next };
}

// One Telegram message per check, so a burst of problems is one notification, split only when long.
export function batch(messages: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const m of messages.map((m) => clip(m, MAX_MESSAGE))) {
    if (current && current.length + m.length + 2 > MAX_MESSAGE) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${m}` : m;
  }
  if (current) out.push(current);
  return out;
}

export type SendMessage = (text: string) => Promise<void>;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

// Environment variables win; otherwise <data dir>/telegram.json, which a supervised restart
// picks up without the owner restarting the launcher's shell.
export function telegramConfig(env: NodeJS.ProcessEnv, dataDir: string): TelegramConfig | null {
  let file: Partial<TelegramConfig> = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dataDir, "telegram.json"), "utf8")) as Partial<TelegramConfig>;
  } catch {
    // No file: Telegram stays off unless the environment sets it.
  }
  const botToken = (env.AGENT_DASHBOARD_TELEGRAM_BOT_TOKEN ?? file.botToken)?.toString().trim();
  const chatId = (env.AGENT_DASHBOARD_TELEGRAM_CHAT_ID ?? file.chatId)?.toString().trim();
  return botToken && chatId ? { botToken, chatId } : null;
}

export function telegramSender({ botToken, chatId }: TelegramConfig, fetchImpl: typeof fetch = fetch): SendMessage {
  return async (text) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { description?: string } | null;
      // The token is part of the URL, so errors quote Telegram's description, never the request.
      throw new Error(`Telegram refused the message (${response.status}): ${body?.description ?? response.statusText}`);
    }
  };
}

export interface NotifierDeps {
  store: Store;
  runner: Runner;
  inbox: () => Inbox;
  providers: () => ProviderQuotaView[];
  dataDir: string;
  send: SendMessage | null;
  now?: () => number;
}

export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private readonly file: string;
  lastError: string | null = null;

  constructor(private readonly deps: NotifierDeps) {
    this.file = path.join(deps.dataDir, "notified.json");
  }

  get enabled(): boolean {
    return this.deps.send !== null;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.check(), NOTIFY_INTERVAL_MS);
    this.timer.unref();
    void this.check();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async test(): Promise<void> {
    if (!this.deps.send) throw new Error("Telegram is not configured.");
    await this.deps.send("AgentDashboard: Telegram alerts are working. You will hear here when agents stop making progress.");
  }

  alerts(): OwnerAlert[] {
    const { store, runner } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const active = runner.activeRuns().length;
    const projects = store
      .listProjects()
      // A paused project is the owner's choice, not a problem.
      .filter((p) => !p.automationPaused)
      .map((project) => {
        const tasks = store
          .listTasks(project.id)
          .filter((t) => t.stage !== "closed" && t.status !== "done")
          .map((task) => ({ task, runs: store.listRuns(task.id) }));
        const running = tasks.reduce((n, t) => n + t.runs.filter((r) => r.status === "running").length, 0);
        return { project, health: projectHealth({ now, tasks, runningElsewhere: Math.max(0, active - running) }) };
      });
    return ownerAlerts({ projects, providers: this.deps.providers(), inbox: this.deps.inbox() });
  }

  async check(): Promise<void> {
    const send = this.deps.send;
    if (!send || this.checking) return;
    this.checking = true;
    try {
      const { messages, next } = alertChanges(this.readSent(), this.alerts());
      for (const text of batch(messages)) await send(text);
      // Saved only after sending, so a failed send is retried on the next check.
      this.writeSent(next);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.checking = false;
    }
  }

  // Kept on disk so a server restart does not resend every open problem.
  private readSent(): Map<string, string | null> {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string | null>;
      return new Map(Object.entries(saved));
    } catch {
      return new Map();
    }
  }

  private writeSent(sent: Map<string, string | null>): void {
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(sent), null, 2));
  }
}
