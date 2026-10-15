import { DatabaseSync } from "node:sqlite";

// Each entry upgrades the schema by one version; PRAGMA user_version records how many have run.
// Append new migrations, never edit a shipped one: users' databases already ran it.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    default_model TEXT NOT NULL,
    default_effort TEXT NOT NULL,
    allowed_tools TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    session_started INTEGER NOT NULL DEFAULT 0,
    can_edit INTEGER NOT NULL DEFAULT 1,
    model TEXT,
    effort TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id, updated_at);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_task ON messages(task_id, created_at);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    session_id TEXT,
    usage TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX runs_task ON runs(task_id, started_at);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: the studio. Departments own folders, roles describe jobs, agents staff roles; role tasks
  // queue with a priority; proposals, handoffs and feedback wait for the owner.
  `
  CREATE TABLE departments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    weight INTEGER NOT NULL,
    daily_budget_usd REAL,
    folders TEXT NOT NULL,
    autonomy TEXT NOT NULL,
    sort INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX departments_project ON departments(project_id, sort);
  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    brief TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    can_edit INTEGER NOT NULL,
    allowed_tools TEXT,
    context_docs TEXT NOT NULL,
    sort INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX roles_department ON roles(department_id, sort);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX agents_role ON agents(role_id);
  ALTER TABLE tasks ADD COLUMN role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN agent_id TEXT;
  ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;
  ALTER TABLE tasks ADD COLUMN emergency INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
  ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN created_by_role_id TEXT;
  ALTER TABLE tasks ADD COLUMN question TEXT;
  ALTER TABLE runs ADD COLUMN role_id TEXT;
  ALTER TABLE runs ADD COLUMN agent_id TEXT;
  ALTER TABLE runs ADD COLUMN department_id TEXT;
  ALTER TABLE runs ADD COLUMN wait_reason TEXT;
  ALTER TABLE runs ADD COLUMN forced INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN prompt TEXT;
  CREATE INDEX runs_status ON runs(status);
  CREATE INDEX runs_ended ON runs(ended_at);
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    run_id TEXT,
    role_name TEXT,
    doc_path TEXT NOT NULL,
    rationale TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    from_role_name TEXT,
    to_role_name TEXT NOT NULL,
    role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    priority INTEGER NOT NULL,
    emergency INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    reason TEXT,
    status TEXT NOT NULL,
    created_task_id TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX feedback_project ON feedback(project_id, created_at);
  `,
  // 3: Codex as a second provider next to Claude Code, chosen per project, role and task.
  `
  ALTER TABLE projects ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE roles ADD COLUMN provider TEXT;
  ALTER TABLE tasks ADD COLUMN provider TEXT;
  ALTER TABLE tasks ADD COLUMN session_provider TEXT;
  ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
  UPDATE tasks SET session_provider = 'claude' WHERE session_id IS NOT NULL;
  `,
  // 4: Sessions can be replaced without losing task history or cumulative usage.
  `
  ALTER TABLE tasks ADD COLUMN handoff TEXT;
  ALTER TABLE tasks ADD COLUMN handoff_run_id TEXT;
  ALTER TABLE tasks ADD COLUMN auto_compact INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN token_budget INTEGER DEFAULT 1000000;
  ALTER TABLE tasks ADD COLUMN tool_budget INTEGER DEFAULT 80;
  ALTER TABLE runs ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work';
  UPDATE runs SET tool_calls = -1;
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
