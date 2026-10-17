import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db.ts";
import { api, newProject, newTask, runFinished, tempDir, testApp } from "./helpers.ts";

describe("existing version 5 databases", () => {
  for (const legacy of [true, false]) {
    it(`upgrades ${legacy ? "the original" : "the expanded"} schema and can run a chat`, async () => {
      const dataDir = tempDir("ad-migration-");
      const before = await testApp(dataDir);
      const projectId = await newProject(before);
      const saved = await newTask(before, projectId, { title: "Keep this chat" });
      await before.close();
      const db = openDb(path.join(dataDir, "dashboard.db"));
      try {
        if (legacy) {
          db.exec(`ALTER TABLE tasks DROP COLUMN step_state;
            ALTER TABLE tasks DROP COLUMN base_commit;
            ALTER TABLE tasks DROP COLUMN auto_continues;
            ALTER TABLE projects DROP COLUMN auto_review;
            ALTER TABLE projects DROP COLUMN auto_continue_steps;
            ALTER TABLE projects DROP COLUMN start_next_when_idle;`);
        }
        db.exec("PRAGMA user_version = 5");
        migrate(db);
        migrate(db);
        expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 10 });
      } finally {
        db.close();
      }
      const app = await testApp(dataDir);
      try {
        expect(app.store.getTask(saved.id)?.title).toBe("Keep this chat");
        const created = await api<{ id: string }>(app, "POST", `/api/projects/${projectId}/tasks`, { message: "Hello [tool]" });
        expect(created.status).toBe(201);
        const run = app.store.listRuns(created.body.id)[0]!;
        expect((await runFinished(app, run.id)).status).toBe("succeeded");
        expect(app.runner.readEvents(run.id).some(({ event }) => event.kind === "tool_use")).toBe(true);
        expect(app.runner.activeCount()).toBe(0);
      } finally {
        await app.close();
      }
    });
  }
});
