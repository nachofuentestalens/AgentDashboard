import fs from "node:fs";
import path from "node:path";
import type { Department, DesignDoc, DocCommit } from "@ad/shared";
import { HttpError } from "./http.ts";
import { DECISIONS_DOC, DESIGN_DIR, ownerOf } from "./folders.ts";
import { commitFiles, git } from "./git.ts";

// Design documents are Markdown files under design/ in the game's repository. The repository is
// the source of truth; nothing about them is stored in the database.

const MAX_DOCS = 500;
const SEGMENT = /^[A-Za-z0-9 ._-]+$/;

// A repository-relative path to a design document, checked so neither an agent's proposal nor a
// request can reach outside design/.
export function safeDocPath(repo: string, rel: string): string {
  const p = rel.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = p.split("/");
  const ok = parts[0] === DESIGN_DIR && parts.length >= 2 && p.endsWith(".md") && parts.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
  if (!ok) throw new HttpError(`Design documents are .md files under ${DESIGN_DIR}/, like ${DESIGN_DIR}/game/combat.md (got "${rel}").`, 400);
  const root = path.resolve(repo, DESIGN_DIR);
  const full = path.resolve(repo, ...parts);
  if (!full.startsWith(root + path.sep)) throw new HttpError("That path leaves the design folder.", 400);
  // A symlink inside design/ could still point elsewhere.
  if (fs.existsSync(full) && !fs.realpathSync.native(full).startsWith(fs.realpathSync.native(root) + path.sep))
    throw new HttpError("That path leaves the design folder.", 400);
  return p;
}

function describe(content: string, rel: string): { title: string; summary: string } {
  const lines = content.split(/\r?\n/);
  const heading = lines.find((l) => /^#\s+/.test(l));
  const title = heading ? heading.replace(/^#\s+/, "").trim() : path.basename(rel, ".md");
  const first = lines.find((l) => l.trim() && !/^(#|```|---|\||<!--)/.test(l.trim())) ?? "";
  const summary = first
    .replace(/[*_`>]/g, "")
    .replace(/^\s*[-+]\s+/, "")
    .trim();
  return { title, summary: summary.length > 160 ? `${summary.slice(0, 157)}…` : summary };
}

function toDoc(repo: string, rel: string, departments: Department[]): DesignDoc & { content: string } {
  const full = path.join(repo, ...rel.split("/"));
  const content = fs.readFileSync(full, "utf8");
  const stat = fs.statSync(full);
  return {
    path: rel,
    ...describe(content, rel),
    departmentId: ownerOf(rel, departments)?.id ?? null,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    content,
  };
}

export function listDocs(repo: string, departments: Department[]): DesignDoc[] {
  const root = path.join(repo, DESIGN_DIR);
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_DOCS || entry.name.startsWith(".")) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(childRel);
    }
  };
  walk(root, DESIGN_DIR);
  return found.map((rel) => {
    const { content: _content, ...doc } = toDoc(repo, rel, departments);
    return doc;
  });
}

export function readDoc(repo: string, rel: string, departments: Department[]): { doc: DesignDoc; content: string } | null {
  const p = safeDocPath(repo, rel);
  if (!fs.existsSync(path.join(repo, ...p.split("/")))) return null;
  const { content, ...doc } = toDoc(repo, p, departments);
  return { doc, content };
}

export function readDocText(repo: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(repo, ...safeDocPath(repo, rel).split("/")), "utf8");
  } catch {
    return null;
  }
}

export async function docHistory(repo: string, rel: string): Promise<DocCommit[]> {
  const p = safeDocPath(repo, rel);
  const log = await git(repo, ["log", "-n", "20", "--format=%H%x09%aI%x09%s", "--", p]);
  if (!log.ok || !log.stdout) return [];
  return log.stdout.split("\n").map((line) => {
    const [hash = "", date = "", ...subject] = line.split("\t");
    return { hash, date, subject: subject.join("\t") };
  });
}

function writeFile(repo: string, rel: string, content: string) {
  const full = path.join(repo, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.endsWith("\n") ? content : `${content}\n`);
}

const DECISIONS_HEADER =
  "# Decisions\n\nWhat the owner decided, appended by AgentDashboard when a proposal is accepted or a question answered. Newest last. Agents follow these.\n";

function appendDecisionFile(repo: string, entry: { title: string; body: string }) {
  const full = path.join(repo, ...DECISIONS_DOC.split("/"));
  const existing = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : DECISIONS_HEADER;
  const date = new Date().toISOString().slice(0, 10);
  writeFile(repo, DECISIONS_DOC, `${existing.trimEnd()}\n\n## ${date} · ${entry.title}\n\n${entry.body.trim()}\n`);
}

export interface Saved {
  // The files are written either way; a failed commit (another git process holding the index,
  // a hook refusing) is reported so the owner can commit by hand.
  commitError: string | null;
}

// Writes documents and, optionally, a decision entry, then commits them together.
export async function saveDocs(
  repo: string,
  input: { files: { path: string; content: string }[]; decision?: { title: string; body: string }; message: string },
): Promise<Saved> {
  const paths = input.files.map((f) => safeDocPath(repo, f.path));
  input.files.forEach((f, i) => writeFile(repo, paths[i]!, f.content));
  if (input.decision) {
    appendDecisionFile(repo, input.decision);
    paths.push(DECISIONS_DOC);
  }
  const commit = await commitFiles(repo, paths, input.message);
  return { commitError: commit.error };
}
