import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { attentionItems, finishedRunAlert, newAttention, type AttentionItem, type Inbox, type Run, type TaskDetail } from "@ad/shared";
import { api, keys } from "./api.ts";
import { RUN_FINISHED } from "./live.ts";

const TITLE = "AgentDashboard";
const PREF_KEY = "ad.desktopAlerts";

export type AlertState = "unsupported" | "off" | "on" | "blocked";

// Desktop alerts are this browser's choice (its permission and a local preference), not a
// dashboard setting: the server has no say in what a browser shows.
function alertState(): AlertState {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && localStorage.getItem(PREF_KEY) === "on" ? "on" : "off";
}

export function useDesktopAlerts(): { state: AlertState; toggle: () => void } {
  const [state, setState] = useState<AlertState>(alertState);
  const toggle = useCallback(() => {
    if (state === "unsupported" || state === "blocked") return;
    if (state === "on") {
      localStorage.setItem(PREF_KEY, "off");
      setState("off");
      return;
    }
    // Browsers only ask for permission from a click, so this runs in the toggle's handler.
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") localStorage.setItem(PREF_KEY, "on");
      setState(alertState());
    });
  }, [state]);
  return { state, toggle };
}

// Shows the waiting count in the tab title, and a desktop alert for each new thing waiting on the
// owner while the dashboard is not the focused window.
export function useAttention(inbox: Inbox | undefined, alerts: AlertState): void {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const seen = useRef<Set<string> | null>(null);
  const announcedRuns = useRef(new Set<string>());

  const notify = useCallback(
    (fresh: AttentionItem[], title: string) => {
      if (fresh.length === 0 || alerts !== "on" || document.hasFocus()) return;
      const first = fresh[0]!;
      const notification = new Notification(title, {
        body: fresh.length === 1 ? first.text : `${first.text}, and ${fresh.length - 1} more`,
        icon: "/favicon.svg",
        // One alert at a time: a newer one replaces the last instead of piling up.
        tag: "agentdashboard-attention",
      });
      notification.onclick = () => {
        window.focus();
        void navigate(fresh.length === 1 ? first.url : "/inbox");
        notification.close();
      };
    },
    [alerts, navigate],
  );

  useEffect(() => {
    document.title = inbox?.count ? `(${inbox.count}) ${TITLE}` : TITLE;
  }, [inbox?.count]);

  useEffect(() => {
    if (!inbox) return;
    const items = attentionItems(inbox);
    const fresh = newAttention(seen.current, items);
    seen.current = new Set(items.map((i) => i.key));
    notify(fresh, `${TITLE} needs you`);
  }, [inbox, notify]);

  useEffect(() => {
    const onFinished = (event: Event) => {
      const run = (event as CustomEvent<Run>).detail;
      // The same finished run can be pushed more than once.
      if (announcedRuns.current.has(run.id)) return;
      const title = qc.getQueryData<TaskDetail>(keys.task(run.taskId))?.task.title;
      void (title ? Promise.resolve(title) : api.task(run.taskId).then((d) => d.task.title)).then(
        (t) => {
          const item = finishedRunAlert(run, t);
          if (!item || announcedRuns.current.has(run.id)) return;
          announcedRuns.current.add(run.id);
          notify([item], TITLE);
        },
        () => undefined,
      );
    };
    window.addEventListener(RUN_FINISHED, onFinished);
    return () => window.removeEventListener(RUN_FINISHED, onFinished);
  }, [qc, notify]);
}
