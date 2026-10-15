import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Project } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { Button, ErrorNote, inputClass } from "../components/ui.tsx";
import { ago } from "../format.ts";

export function DocsTab({ project }: { project: Project }) {
  const docs = useQuery({ queryKey: keys.docs(project.id), queryFn: () => api.docs(project.id) });
  const studio = useQuery({ queryKey: keys.studio(project.id), queryFn: () => api.studio(project.id) });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ path: string; content: string; isNew: boolean } | null>(null);
  const current = selected ?? docs.data?.[0]?.path ?? null;
  const detail = useQuery({ queryKey: keys.doc(project.id, current ?? ""), queryFn: () => api.doc(project.id, current!), enabled: !!current && !draft?.isNew });
  const save = useMutation({
    mutationFn: (d: { path: string; content: string }) => api.saveDoc(project.id, d.path, d.content),
    onSuccess: (_saved, d) => {
      setSelected(d.path);
      setDraft(null);
    },
  });
  const deptName = (id: string | null) => studio.data?.departments.find((d) => d.id === id)?.name;
  const deptColor = (id: string | null) => studio.data?.departments.find((d) => d.id === id)?.color;

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-ink-800 px-3 py-4">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold tracking-wider text-ink-400 uppercase">design/</span>
          <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => setDraft({ path: "design/", content: "# Title\n\n", isNew: true })}>
            + New
          </Button>
        </div>
        {docs.data?.length === 0 && (
          <p className="px-1 text-xs text-ink-400">No design documents yet. Write one, or ask the CTO and Game Director to start the studio's documents.</p>
        )}
        <ul className="space-y-0.5">
          {docs.data?.map((doc) => (
            <li key={doc.path}>
              <button
                onClick={() => {
                  setSelected(doc.path);
                  setDraft(null);
                }}
                className={`block w-full rounded-md px-2 py-1.5 text-left ${doc.path === current && !draft?.isNew ? "bg-ink-800" : "hover:bg-ink-850"}`}
              >
                <span className="block truncate text-sm text-ink-100">{doc.title}</span>
                <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-ink-400">
                  {deptColor(doc.departmentId) && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: deptColor(doc.departmentId) }} />}
                  {doc.path.slice("design/".length)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <ErrorNote error={docs.error ?? detail.error} />
        {draft ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            {draft.isNew ? (
              <input
                aria-label="Document path"
                className={`${inputClass} font-mono`}
                value={draft.path}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                placeholder="design/game/combat.md"
              />
            ) : (
              <p className="font-mono text-xs text-ink-400">{draft.path}</p>
            )}
            <textarea
              aria-label="Document content"
              className={`${inputClass} min-h-[60vh] font-mono text-xs leading-relaxed`}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
            <ErrorNote error={save.error} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={save.isPending}>
                Save and commit
              </Button>
              <Button onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </form>
        ) : detail.data ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <span className="font-mono text-xs text-ink-400">{detail.data.doc.path}</span>
              {deptName(detail.data.doc.departmentId) && <span className="text-xs text-ink-300">owned by {deptName(detail.data.doc.departmentId)}</span>}
              {detail.data.doc.path !== "design/decisions.md" && (
                <Button className="ml-auto text-xs" onClick={() => setDraft({ path: detail.data!.doc.path, content: detail.data!.content, isNew: false })}>
                  Edit
                </Button>
              )}
            </div>
            {save.data?.commitError && <ErrorNote error={new Error(`Saved, but the commit failed: ${save.data.commitError}`)} />}
            <article className="max-w-3xl text-sm">
              <Markdown text={detail.data.content} />
            </article>
            {detail.data.history.length > 0 && (
              <details className="mt-8 text-xs text-ink-400">
                <summary className="cursor-pointer">History ({detail.data.history.length})</summary>
                <ul className="mt-2 space-y-1">
                  {detail.data.history.map((c) => (
                    <li key={c.hash} className="flex gap-3">
                      <span className="font-mono">{c.hash.slice(0, 7)}</span>
                      <span className="text-ink-300">{c.subject}</span>
                      <span className="ml-auto">{ago(c.date)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
