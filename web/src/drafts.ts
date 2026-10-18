import { useCallback, useState } from "react";

const PREFIX = "ad:draft:";

function read(key: string | undefined): string {
  if (!key) return "";
  try {
    return localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string | undefined, text: string) {
  if (!key) return;
  try {
    if (text) localStorage.setItem(PREFIX + key, text);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage full or blocked: the draft still lives in memory for this view.
  }
}

// Text typed into a box, kept in localStorage per key so switching tasks, tabs or projects
// (which unmounts or reuses the box) never loses it. No key means plain component state.
export function useDraft(key: string | undefined): [string, (text: string) => void] {
  const [state, setState] = useState(() => ({ key, text: read(key) }));
  // The same component can be reused for another task: load that task's draft instead of carrying text over.
  if (state.key !== key) setState({ key, text: read(key) });
  const text = state.key === key ? state.text : read(key);
  const setText = useCallback(
    (value: string) => {
      setState({ key, text: value });
      write(key, value);
    },
    [key],
  );
  return [text, setText];
}
