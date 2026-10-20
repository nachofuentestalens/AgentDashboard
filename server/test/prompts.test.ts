import { expect, it } from "vitest";
import type { Department, Role, Task } from "@ad/shared";
import { roleSystemPrompt, studioContext } from "../src/prompts.ts";

const base = {
  departments: [],
  roles: [],
  docs: [],
  contextDocs: [{ path: "design/large.md", content: "x".repeat(30000) }],
  task: { title: "Fix bug", priority: 5 } as Task,
  fromRole: null,
};
it("bounds injected documents and omits their contents on resumed turns", () => {
  const first = studioContext({ ...base, firstTurn: true });
  expect(first.length).toBeLessThan(8500);
  expect(first).toContain("read the file for the rest");
  const resumed = studioContext({ ...base, firstTurn: false, includeCatalog: false });
  expect(resumed).not.toContain("design/large.md");
  expect(resumed).toContain("catalog unchanged");
  expect(resumed).toContain("Fix bug");
});

it("tells hands-off agents to decide routine questions themselves", () => {
  const department = { id: "d", name: "QA", folders: ["qa"] } as Department;
  const input = { projectName: "Game", department, departments: [department], role: { name: "QA Tester", brief: "", canEdit: true } as Role, agentName: "Ada" };
  expect(roleSystemPrompt(input)).not.toContain("Hands-off delivery");
  const handsOff = roleSystemPrompt({ ...input, handsOff: true });
  expect(handsOff).toContain("## Hands-off delivery");
  expect(handsOff).toContain("task block instead of a proposal");
});
