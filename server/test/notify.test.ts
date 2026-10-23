import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Inbox, Project, ProviderQuotaView, Task } from "@ad/shared";
import { alertChanges, batch, Notifier, ownerAlerts, SETTLE_MS, telegramConfig, telegramSender, type NotifierDeps } from "../src/notify.ts";
import type { Runner } from "../src/runner.ts";
import type { Store } from "../src/store.ts";
import { api, tempDir, testApp } from "./helpers.ts";

const provider = (p: "claude" | "codex", level: ProviderQuotaView["level"]) => ({ provider: p, level, reason: `${p} is ${level}` }) as ProviderQuotaView;
const project = { id: "p1", name: "Banner & Bounty" } as Project;
const noInbox = { alerts: [], questions: [] } as Pick<Inbox, "alerts" | "questions">;

describe("owner alerts", () => {
  it("covers out-of-quota providers, health concerns, steward alerts and questions", () => {
    const alerts = ownerAlerts({
      providers: [provider("claude", "conserve"), provider("codex", "exhausted")],
      projects: [
        {
          project,
          health: {
            overview: "",
            concerns: [
              {
                key: "stall:r1:0",
                kind: "stall",
                title: "Nothing has run for 15 min while 1 run waits",
                detail: "Queued runs: 1\nWait reasons:\n- 1 × Coordinator: hold\nIf the reasons cannot explain the stall, report it.",
                taskId: "t1",
                runId: "r1",
              },
            ],
          },
        },
      ],
      inbox: {
        alerts: [{ projectId: "p1", projectName: "Banner & Bounty", key: "k", title: "Escalated" }] as Inbox["alerts"],
        questions: [{ task: { id: "t2", title: "Playtest", question: "Which build?", updatedAt: "x" } as Task }] as Inbox["questions"],
      },
    });
    // A conserving provider still works, so only Codex is reported.
    expect(alerts.map((a) => a.key)).toEqual(["provider:codex", "health:p1:stall:r1:0", "alert:p1:k", expect.stringContaining("t2")]);
    expect(alerts[0]!.recovery).toBe("Codex agents can work again.");
    expect(alerts[1]!.text).toBe("Banner & Bounty: Nothing has run for 15 min while 1 run waits\n- 1 × Coordinator: hold");
    expect(alerts[3]!.text).toContain("Which build?");
  });

  it("skips stalls caused by quota holds", () => {
    const stall = { key: "stall:r1:0", kind: "stall" as const, title: "Nothing has run", detail: "", taskId: "t1", runId: "r1", quotaHold: true };
    const alerts = ownerAlerts({ providers: [], projects: [{ project, health: { overview: "", concerns: [stall] } }], inbox: noInbox });
    expect(alerts).toEqual([]);
  });

  it("sends each alert once and a recovery when a recoverable one stays away", () => {
    const exhausted = ownerAlerts({ providers: [provider("claude", "exhausted")], projects: [], inbox: noInbox });
    const first = alertChanges(new Map(), exhausted, 0);
    expect(first.messages).toEqual(["⚠️ Claude agents are waiting: claude is exhausted"]);
    expect(alertChanges(first.next, exhausted, 1).messages).toEqual([]);
    // Moving between reserve and exhausted is the same wait.
    const reserve = ownerAlerts({ providers: [provider("claude", "reserve")], projects: [], inbox: noInbox });
    expect(alertChanges(first.next, reserve, 1).messages).toEqual([]);
    // A flapping alert is neither recovered nor resent while it settles.
    const gone = alertChanges(first.next, [], 1000);
    expect(gone.messages).toEqual([]);
    const back = alertChanges(gone.next, exhausted, 2000);
    expect(back.messages).toEqual([]);
    const goneAgain = alertChanges(back.next, [], 3000);
    expect(alertChanges(goneAgain.next, [], 3000 + SETTLE_MS - 1).messages).toEqual([]);
    const settled = alertChanges(goneAgain.next, [], 3000 + SETTLE_MS);
    expect(settled.messages).toEqual(["✅ Claude agents can work again."]);
    expect(settled.next.size).toBe(0);
    // Other alerts are forgotten silently once settled, so a later recurrence is sent again.
    expect(alertChanges(new Map([["health:p1:x", { recovery: null, goneAt: 0 }]]), [], SETTLE_MS)).toEqual({ messages: [], next: new Map() });
  });

  it("batches messages into as few Telegram messages as fit", () => {
    expect(batch(["a", "b"])).toEqual(["a\n\nb"]);
    expect(batch([])).toEqual([]);
    expect(batch(["x".repeat(3000), "y".repeat(3000)])).toHaveLength(2);
    expect(batch(["z".repeat(5000)])[0]!.length).toBeLessThanOrEqual(3800);
  });
});

describe("telegram", () => {
  it("reads the environment first, then telegram.json", () => {
    const dir = tempDir("ad-tg-");
    expect(telegramConfig({}, dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "telegram.json"), JSON.stringify({ botToken: "file", chatId: 42 }));
    expect(telegramConfig({}, dir)).toEqual({ botToken: "file", chatId: "42" });
    expect(telegramConfig({ AGENT_DASHBOARD_TELEGRAM_BOT_TOKEN: "env" }, dir)).toEqual({ botToken: "env", chatId: "42" });
  });

  it("posts to the Bot API and never quotes the token in errors", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await telegramSender({ botToken: "SECRET", chatId: "7" }, ok)("hello");
    expect(calls[0]!.url).toBe("https://api.telegram.org/botSECRET/sendMessage");
    expect(calls[0]!.body).toMatchObject({ chat_id: "7", text: "hello" });

    const refused = (async () => new Response(JSON.stringify({ description: "Bad Request: chat not found" }), { status: 400 })) as typeof fetch;
    const error = await telegramSender({ botToken: "SECRET", chatId: "7" }, refused)("hi").catch((e: Error) => e.message);
    expect(error).toContain("chat not found");
    expect(error).not.toContain("SECRET");
  });
});

describe("notifier", () => {
  const deps = (dataDir: string, providers: ProviderQuotaView[][], send: NotifierDeps["send"]): NotifierDeps => ({
    store: { listProjects: () => [] } as unknown as Store,
    runner: { activeRuns: () => [] } as unknown as Runner,
    inbox: () => noInbox as Inbox,
    providers: () => providers[0]!,
    dataDir,
    send,
    now: () => clock,
  });
  let clock = 0;

  it("remembers sent alerts across restarts and retries a failed send", async () => {
    const dataDir = tempDir("ad-notify-");
    clock = 0;
    const sent: string[] = [];
    let fail = true;
    const providers = [[provider("claude", "reserve")]];
    const send = async (text: string) => {
      if (fail) throw new Error("offline");
      sent.push(text);
    };
    const notifier = new Notifier(deps(dataDir, providers, send));
    await notifier.check();
    expect(notifier.lastError).toBe("offline");
    fail = false;
    await notifier.check();
    expect(sent).toHaveLength(1);
    expect(notifier.lastError).toBeNull();

    const restarted = new Notifier(deps(dataDir, providers, send));
    await restarted.check();
    expect(sent).toHaveLength(1);
    providers[0] = [provider("claude", "ok")];
    await restarted.check();
    expect(sent).toHaveLength(1);
    clock += SETTLE_MS;
    await restarted.check();
    expect(sent.at(-1)).toBe("✅ Claude agents can work again.");
  });

  it("reads the older notified.json format", async () => {
    const dataDir = tempDir("ad-notify-");
    fs.writeFileSync(path.join(dataDir, "notified.json"), JSON.stringify({ "provider:claude:reserve": "Claude agents can work again." }));
    const sent: string[] = [];
    await new Notifier(deps(dataDir, [[provider("claude", "exhausted")]], async (text) => void sent.push(text))).check();
    expect(sent).toEqual([]);
  });

  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reports whether Telegram is configured and sends a test message", async () => {
    const sent: string[] = [];
    app = await testApp(undefined, { notify: async (text) => void sent.push(text) });
    expect((await api(app, "GET", "/api/notifications")).body).toEqual({ telegram: true, lastError: null });
    expect((await api(app, "POST", "/api/notifications/test", {})).status).toBe(200);
    expect(sent.at(-1)).toContain("Telegram alerts are working");
  });

  it("refuses a test when Telegram is off", async () => {
    app = await testApp();
    expect((await api(app, "POST", "/api/notifications/test", {})).status).toBe(409);
  });
});
