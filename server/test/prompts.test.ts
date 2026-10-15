import { expect, it } from "vitest";
import type { Task } from "@ad/shared";
import { studioContext } from "../src/prompts.ts";

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
