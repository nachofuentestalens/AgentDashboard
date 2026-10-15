import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, ApiError } from "../api.ts";
import { Button, Dialog, ErrorNote, Field, inputClass } from "../components/ui.tsx";

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const create = useMutation({
    mutationFn: (initGit: boolean) => api.createProject({ name: name.trim(), repoPath: repoPath.trim(), initGit }),
    onSuccess: (project) => {
      setName("");
      setRepoPath("");
      create.reset();
      onClose();
      void navigate(`/projects/${project.id}`);
    },
  });
  const canInit = create.error instanceof ApiError && create.error.body.canInit === true;

  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(false);
        }}
      >
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Idle Quest" autoFocus />
        </Field>
        <Field label="Repository folder" hint="The top folder of the game's git repository. Agents work inside it.">
          <input
            className={`${inputClass} font-mono`}
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="C:\Users\you\Projects\idle-quest"
          />
        </Field>
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {canInit && (
            <Button onClick={() => create.mutate(true)} disabled={create.isPending}>
              Create git repository there
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!name.trim() || !repoPath.trim() || create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
