import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { attentionItems, newAttention, type Inbox } from "@ad/shared";

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
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    document.title = inbox?.count ? `(${inbox.count}) ${TITLE}` : TITLE;
  }, [inbox?.count]);

  useEffect(() => {
    if (!inbox) return;
    const items = attentionItems(inbox);
    const fresh = newAttention(seen.current, items);
    seen.current = new Set(items.map((i) => i.key));
    if (fresh.length === 0 || alerts !== "on" || document.hasFocus()) return;
    const first = fresh[0]!;
    const notification = new Notification(`${TITLE} needs you`, {
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
  }, [inbox, alerts, navigate]);
}
