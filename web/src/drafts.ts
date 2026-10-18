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

function readJson<T>(key: string): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// An unsaved form (several fields), kept like useDraft until it is saved or discarded with null.
// Nothing is stored until the first edit, so opening and closing a form leaves no draft behind.
export function useStoredDraft<T>(key: string): [T | null, (value: T | null) => void] {
  const [state, setState] = useState(() => ({ key, value: readJson<T>(key) }));
  if (state.key !== key) setState({ key, value: readJson<T>(key) });
  const value = state.key === key ? state.value : readJson<T>(key);
  const setValue = useCallback(
    (next: T | null) => {
      setState({ key, value: next });
      write(key, next === null ? "" : JSON.stringify(next));
    },
    [key],
  );
  return [value, setValue];
}
