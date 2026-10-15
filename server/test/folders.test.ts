import { describe, expect, it } from "vitest";
import { folder, type Department } from "@ad/shared";
import { safeDocPath } from "../src/docs.ts";
import { describeArea, editRules, ownerOf } from "../src/folders.ts";
import { tempDir } from "./helpers.ts";

const dept = (id: string, folders: string[]): Department => ({
  id,
  projectId: "p",
  name: id,
  color: "#000000",
  weight: 3,
  dailyBudgetUsd: null,
  folders,
  autonomy: "ask",
  sort: 0,
  createdAt: "",
});

const leadership = dept("Leadership", ["design/studio"]);
const engineering = dept("Engineering", ["."]);
const design = dept("Design", ["design"]);
const qa = dept("QA", ["qa"]);
const all = [leadership, engineering, design, qa];

describe("department folders", () => {
  it("normalises and validates folder names", () => {
    expect(folder.parse(" ./src/game/ ")).toBe("src/game");
    expect(folder.parse("design\\game")).toBe("design/game");
    expect(folder.parse("./")).toBe(".");
    for (const bad of ["../x", "a/../b", "/abs", "has space", "C:\\x", "a,b"]) expect(folder.safeParse(bad).success).toBe(false);
  });

  it("gives a path to the most specific folder", () => {
    expect(ownerOf("design/studio/vision.md", all)?.id).toBe("Leadership");
    expect(ownerOf("design/game/combat.md", all)?.id).toBe("Design");
    expect(ownerOf("src/main.ts", all)?.id).toBe("Engineering");
    expect(ownerOf("qa", all)?.id).toBe("QA");
    expect(ownerOf("qa-notes/x", all)?.id).toBe("Engineering");
  });

  it("confines a department to its folders, minus folders others own inside them", () => {
    expect(editRules(design, all)).toEqual({
      mode: "default",
      allow: ["Edit(./design/**)"],
      deny: ["Edit(./design/studio/**)", "Edit(./design/decisions.md)"],
    });
    expect(describeArea(design, all)).toBe("only in `design/`, except `design/studio/`");
  });

  it("lets a '.' department edit everything other departments do not own", () => {
    expect(editRules(engineering, all)).toEqual({
      mode: "acceptEdits",
      allow: [],
      deny: ["Edit(./design/studio/**)", "Edit(./design/**)", "Edit(./qa/**)", "Edit(./design/decisions.md)"],
    });
  });
});

describe("design document paths", () => {
  const repo = tempDir("ad-docs-");
  it("accepts .md files under design/ and nothing else", () => {
    expect(safeDocPath(repo, "design\\game\\combat.md")).toBe("design/game/combat.md");
    expect(safeDocPath(repo, "./design/vision.md")).toBe("design/vision.md");
    for (const bad of ["design/../secrets.md", "src/a.md", "design/a.txt", "design", "../design/a.md", "design/a/../../b.md", "/design/a.md"])
      expect(() => safeDocPath(repo, bad)).toThrow();
  });
});
