import { useState, type ReactNode } from "react";
import { Button } from "./ui.tsx";

// The message box. Ctrl/Cmd+Enter sends; plain Enter makes a new line, since briefs are long.
export function Composer({
  onSend,
  disabled,
  busy,
  placeholder,
  sendLabel = "Send",
  footer,
  autoFocus,
}: {
  onSend: (text: string) => Promise<unknown> | void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  sendLabel?: string;
  footer?: ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0 && !disabled && !busy;

  const send = async () => {
    if (!canSend) return;
    const value = text.trim();
    setText("");
    try {
      await onSend(value);
    } catch (error) {
      // Give the text back so nothing typed is lost.
      setText(value);
      throw error;
    }
  };

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 focus-within:border-ink-600">
      <textarea
        aria-label="Message"
        autoFocus={autoFocus}
        className="block max-h-[40vh] min-h-[84px] w-full resize-y bg-transparent px-4 py-3 text-sm text-ink-100 placeholder:text-ink-400 focus:outline-none"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send().catch(() => {});
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-3 border-t border-ink-800 px-3 py-2">
        {footer}
        <span className="ml-auto hidden text-xs text-ink-400 sm:inline">Ctrl+Enter</span>
        <Button variant="primary" onClick={() => void send().catch(() => {})} disabled={!canSend}>
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}
