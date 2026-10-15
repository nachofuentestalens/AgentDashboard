import type { Department } from "@ad/shared";

export const DESIGN_DIR = "design";
// The owner's record of decisions. Only the dashboard appends to it.
export const DECISIONS_DOC = "design/decisions.md";

const inside = (p: string, folder: string) => folder === "." || p === folder || p.startsWith(`${folder}/`);

// The department a repository path belongs to: the one with the most specific folder holding it,
// "." counting as the least specific. Ties go to the earlier department.
export function ownerOf(relPath: string, departments: Department[]): Department | null {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  let best: { dept: Department; depth: number } | null = null;
  for (const dept of departments) {
    for (const folder of dept.folders) {
      if (!inside(p, folder)) continue;
      const depth = folder === "." ? 0 : folder.split("/").length;
      if (!best || depth > best.depth) best = { dept, depth };
    }
  }
  return best?.dept ?? null;
}

export interface EditRules {
  // acceptEdits: edit anywhere except the denied paths. default: edit only the allowed paths.
  mode: "acceptEdits" | "default";
  allow: string[];
  deny: string[];
}

const rule = (folder: string) => `Edit(./${folder}/**)`;

// A writing role's department folders as Claude Code permission rules, so the CLI itself refuses an
// edit outside them. Folders of other departments inside this one's area are denied (deny rules win
// over allow rules), and nobody but the dashboard writes the decision log.
export function editRules(dept: Department, all: Department[]): EditRules {
  const others = all.filter((d) => d.id !== dept.id);
  const deny = [
    ...new Set(
      others
        .flatMap((d) => d.folders)
        .filter((f) => f !== "." && dept.folders.some((own) => inside(f, own)) && ownerOf(`${f}/x`, all)?.id !== dept.id)
        .map(rule),
    ),
    `Edit(./${DECISIONS_DOC})`,
  ];
  if (dept.folders.includes(".")) return { mode: "acceptEdits", allow: [], deny };
  return { mode: "default", allow: dept.folders.map(rule), deny };
}

// What a role may edit, in words for its preamble.
export function describeArea(dept: Department, all: Department[]): string {
  const rules = editRules(dept, all);
  const denied = rules.deny.map((r) => r.slice("Edit(./".length, -1).replace(/\/\*\*$/, "/"));
  if (rules.mode === "acceptEdits") return `anywhere in the repository except ${denied.map((d) => `\`${d}\``).join(", ")}`;
  const allowed = dept.folders.map((f) => `\`${f}/\``).join(", ");
  const blocked = denied.filter((d) => d !== DECISIONS_DOC);
  return blocked.length ? `only in ${allowed}, except ${blocked.map((d) => `\`${d}\``).join(", ")}` : `only in ${allowed}`;
}
