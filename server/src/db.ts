import { DatabaseSync } from "node:sqlite";

// Each entry upgrades the schema by one version; PRAGMA user_version records how many have run.
// Append new migrations, never edit a shipped one: users' databases already ran it.
const MIGRATIONS: (string | ((db: Db) => void))[] = [
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
  // 5: task stages (docs/TASK_STATES.md): progress through a role task's work, separate from the
  // run activity in status. Plain chats keep stage NULL.
  `
  ALTER TABLE tasks ADD COLUMN stage TEXT;
  ALTER TABLE tasks ADD COLUMN reviewer_role_id TEXT;
  ALTER TABLE roles ADD COLUMN reviewer_role_id TEXT;
  ALTER TABLE tasks ADD COLUMN step_summary TEXT;
  ALTER TABLE tasks ADD COLUMN next_step TEXT;
  ALTER TABLE tasks ADD COLUMN step_state TEXT;
  ALTER TABLE tasks ADD COLUMN base_commit TEXT;
  ALTER TABLE tasks ADD COLUMN stage_changed_at TEXT;
  ALTER TABLE tasks ADD COLUMN auto_continues INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN auto_continue_steps INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN start_next_when_idle INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE task_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    summary TEXT,
    run_id TEXT
  );
  CREATE INDEX task_steps_task ON task_steps(task_id, ord);
  CREATE TABLE task_reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT,
    reviewer TEXT NOT NULL,
    verdict TEXT NOT NULL,
    findings TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX task_reviews_task ON task_reviews(task_id, created_at);
  -- Backfill role tasks only: finished ones are closed, untouched ones go to the backlog, the rest
  -- are already in progress.
  UPDATE tasks SET stage = 'in_progress' WHERE role_id IS NOT NULL;
  UPDATE tasks SET stage = 'closed', status = 'idle' WHERE role_id IS NOT NULL AND status = 'done';
  UPDATE tasks SET stage = 'backlog' WHERE role_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = tasks.id);
  `,
  // 6: Version 5 existed in several installations before its schema was expanded.
  // Repair those databases without repeating its backfill or changing saved workflow state.
  (db) => {
    for (const [table, definitions] of Object.entries({
      tasks: ["step_state TEXT", "base_commit TEXT", "auto_continues INTEGER NOT NULL DEFAULT 0"],
      projects: ["auto_review INTEGER NOT NULL DEFAULT 0", "auto_continue_steps INTEGER NOT NULL DEFAULT 0", "start_next_when_idle INTEGER NOT NULL DEFAULT 0"],
    })) {
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
      for (const definition of definitions) {
        if (!columns.has(definition.split(" ")[0]!)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
  },
  // 7: Durable task workspaces survive pauses, crashes and provider changes.
  `
  CREATE TABLE IF NOT EXISTS task_workspaces (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    repo_path TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    checkpoint_commit TEXT,
    checkpoint_at TEXT,
    error TEXT
  );
  `,
  // 8: Remote publication is independent of a successful local checkpoint.
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(task_workspaces)").all() as { name: string }[]).map((c) => c.name));
    for (const name of ["published_commit", "pull_request_url", "publish_error", "merge_commit", "github_repo", "approved_commit"]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE task_workspaces ADD COLUMN ${name} TEXT`);
    }
  },
  // 9: Explicit prerequisite graph and committed input requirements.
  (db) => {
    const taskColumns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
    if (!taskColumns.has("dependency_approved")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN dependency_approved INTEGER NOT NULL DEFAULT 0;
        UPDATE tasks SET dependency_approved = 1 WHERE stage = 'approved' OR
          (stage = 'closed' AND (SELECT verdict FROM task_reviews WHERE task_id = tasks.id ORDER BY created_at DESC, rowid DESC LIMIT 1) = 'approved');`);
    }
    for (const table of ["tasks", "handoffs"]) {
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const name of ["dependency_ids", "required_paths"]) {
        if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT NOT NULL DEFAULT '[]'`);
      }
    }
  },
  // 10: Hands-off delivery, and the checkpoint each agent review saw so an unchanged task is not reviewed again.
  `
  ALTER TABLE projects ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE task_reviews ADD COLUMN reviewed_commit TEXT;
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
      const migration = MIGRATIONS[version]!;
      if (typeof migration === "string") db.exec(migration);
      else migration(db);
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
