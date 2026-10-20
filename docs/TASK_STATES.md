# Design: task stages, step completion and review

Status: agreed design, not implemented. Builds the base that Phase 3 (workflows) extends.

## Problem

`Task.status` mixes two different questions into one value:

- **What is the process doing right now?** queued, running, waiting for an answer, failed.
- **How far along is the work?** not started, a step finished, reviewed, approved, closed.

Today a role task that finishes a run becomes `done` (runner.ts, `next = ... "done"`), and a chat becomes `idle`. Neither says
whether the result was checked. "Done" means "the agent stopped", not "the owner accepted it". So from the task list you cannot tell:

1. which tasks are waiting for **you** (to review, approve, or answer),
2. which finished one step and are ready for the next,
3. which task should start next.

## Proposal: two fields

Keep `status` for the process (rename it in the UI to **activity**) and add a new field, `stage`, for progress through the work.

```
activity (existing TaskStatus, minus "done"):  idle · queued · running · waiting · failed · interrupted
stage    (new):                                backlog · in_progress · needs_review · in_review · changes_requested · approved · closed
```

| Stage               | Meaning                                                               | Whose move                       |
| ------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `backlog`           | Created, not started (no run yet, or put back by the owner)           | Owner: **Start**                 |
| `in_progress`       | The agent is working on the current step, or was asked to continue    | Agent                            |
| `needs_review`      | The agent finished a step (or the whole task) and nobody checked it   | Owner: review, approve, continue |
| `in_review`         | A review run is checking the work                                     | Reviewing agent                  |
| `changes_requested` | A review (agent or owner) found problems; a fix has not started       | Owner: **Fix** (or edit + send)  |
| `approved`          | The owner accepted the work; follow-ups such as a merge may still run | Owner: **Close** (or automatic)  |
| `closed`            | Finished. Hidden from the active list                                 | Owner: **Reopen**                |

**Stages apply only to role tasks** (work given to an "employee"). Plain chats with no role have `stage = null`. They keep
today's behaviour (activity only, `idle` after each reply, Mark done / Reopen), and the UI shows no stage pill or review actions for
them.

`done` leaves `TaskStatus`: a finished role task becomes `activity = idle, stage = needs_review`. Only the owner moves a task to
`approved` or `closed`. An agent's review can recommend approval but cannot approve. This follows the existing rule that nothing an
agent writes changes dashboard state on its own.

### Transitions

```
backlog ──Start──▶ in_progress ──run succeeds──▶ needs_review ──Approve──▶ approved ──Close──▶ closed
   ▲                  ▲   ▲                        │    │                                       │
   └──Move to backlog─┘   │                        │    └──Review with agent──▶ in_review       │
                          │                        │                              │ verdict     │
                          ├──Continue (next step)──┘                              ├─ pass ─▶ needs_review (marked "Agent review: passed")
                          │                                                       └─ changes ▶ changes_requested
                          ├──Fix / owner sends a message──── changes_requested ◀──Request changes (owner)
                          └──────────────────────────────────────── Reopen ◀──── closed
```

Rules that are not shown in the diagram:

- A run that fails or is stopped does not change the stage. The activity shows `failed` or `interrupted`, and Retry stays in the same stage.
- When the agent asks a question (activity `waiting`), the stage stays the same. Answering it continues the work.
- An automatic model switch, a handoff continuation or a budget checkpoint pause stays in `in_progress`. These do not count as a finished step.
- If the owner sends a message in `needs_review` or `changes_requested`, that counts as **Continue** or **Fix**: the stage goes back to `in_progress`.
- **Close** from `approved` is the usual path. The owner can also close (drop) a task from any other stage except `in_review`, while
  no agent is running. `PATCH {done: true}` on `needs_review` approves and then closes.
- `done` stays in `TaskStatus` for plain chats only (Mark done). Role tasks never get it.
- A parent task cannot be approved while it has open child tasks (delegated work). The owner gets a 409 response with the list, or the choice to "approve anyway". Children that depend (directly or transitively) on the parent do not count: they cannot start until it is approved, so counting them would deadlock.

The transitions live in one pure function, `server/src/stages.ts` (`nextStage(stage, event) → stage | error`), tested from a table in
the same way as `scheduler.ts`. `runner.ts` and the routes call it and never set `stage` directly.

## How the server knows a step is done

The agent reports progress with a new reply block, which `blocks.ts` parses like `task`, `proposal` and `question`:

````
```step
{"state": "done", "summary": "Added the dash ability and its tests.", "next": "Tune dash cooldown against design/game/combat.md"}
```
````

- `done`: one step is finished and more remain (`next` describes the following step). Stage becomes `needs_review`.
- `complete`: the agent thinks the whole task is finished. Stage becomes `needs_review`, and the row is marked "Agent: complete".
- `partial`: the agent stopped mid-step, for example on a budget or because it needs input. The stage stays `in_progress`. With
  "start next when idle", an idle staffed role resumes such a step before starting backlog work, counted against the project's
  automatic continuation limit (an owner message resets the count).
- **No block**: a successful work run is treated as `done` (the stage becomes `needs_review`). A malformed block becomes a warning
  notice, as other blocks do.

The block is JSON like the others; `state` is `done`, `partial` or `complete`, and `next` is optional. `state`, `summary` and `next`
are stored on the task (`stepState`, `stepSummary` and `nextStep`) and shown in the list. A finished run without a block clears them. The preamble in `prompts.ts` asks for
the block in one line. Only role tasks act on `step` blocks. A `step` block in a plain chat is ignored.

Optional **plan**: the agent may return a `plan` block, `{"steps": ["…", "…"]}`, listing the steps not finished yet, including the
one the same reply finishes. The server stores it as `task_steps`: a new plan replaces the steps not done, done ones stay. The UI
shows "2/4" on the board and the checklist on the task page. Each finished step (`done`, `complete` or no block) marks the active
step done and activates the next one. Without a plan the task is a single step.
This is the small, agent-driven version of the Phase 3 workflow steps. Those later replace or extend it (approval gates, human
input) on the same table.

## Review with an agent

**Review with agent** starts a run with `purpose: "review"`:

- The run is **read-only** whatever the task's `canEdit`: no edits, only the project's allowed read commands plus `git diff`.
- **Reviewer resolution**, first match wins:
  1. `roleId` passed with the action (a one-off choice from the "Review with agent ▾" picker),
  2. the task's `reviewerRoleId` (set in the task settings),
  3. the author role's default `reviewerRoleId` (set in the Studio role editor, for example Gameplay Programmer → Senior Gameplay Programmer),
  4. otherwise the **same role** as the author.

  The task row shows the resolved reviewer ("Review with Senior Gameplay Programmer"). The reviewer must be a role in the same
  project, which the zod schema and `studio.ts` check. Only the owner sets reviewers: agents cannot choose their own reviewer through
  reply blocks. This makes seniority tiers, QA or a department lead plain configuration later, with no new mechanism. The run uses the
  reviewer role's model, effort, preamble and an agent of that role. It is queued through the scheduler and counts against the
  reviewer's department budget.

- The prompt is fixed by the server: the task title, the latest step summary, the diff of the task's changes (the working tree from
  the task's start commit, recorded on the first run), and "end with a `review` block".
- It starts a **fresh session**, so the reviewer is not anchored to the author's reasoning. The transcript still shows the run inline.

```review
{"verdict": "pass", "findings": ["server/src/x.ts:42 cooldown never resets after death"]}
```

`pass` returns the task to `needs_review` with the badge "Agent review: passed (n findings)". `changes` moves it to
`changes_requested` with the findings listed. **Fix** then sends the findings to the authoring session as the next message. If the
block is missing, the server records a warning and the stage returns to `needs_review`, never to `approved`. The same happens when
the review run fails, is stopped, or the server restarts during it (`review_cancel`). Retrying a review run starts a new review with
the same reviewer and a fresh diff. Handoff and review runs never hold the department's single writer slot.

## Data model

New migration (append-only):

```sql
ALTER TABLE tasks ADD COLUMN stage TEXT;                -- null for plain chats
ALTER TABLE tasks ADD COLUMN reviewer_role_id TEXT;     -- null: the role's default reviewer
ALTER TABLE roles ADD COLUMN reviewer_role_id TEXT;     -- null: the same role reviews its own work
ALTER TABLE tasks ADD COLUMN step_summary TEXT;
ALTER TABLE tasks ADD COLUMN next_step TEXT;
ALTER TABLE tasks ADD COLUMN base_commit TEXT;          -- HEAD when the first run started, for review diffs
ALTER TABLE tasks ADD COLUMN stage_changed_at TEXT;
-- backfill role tasks only: done → closed + idle; without runs → backlog; the rest → in_progress
UPDATE tasks SET stage = 'in_progress' WHERE role_id IS NOT NULL;
UPDATE tasks SET stage = 'closed', status = 'idle' WHERE role_id IS NOT NULL AND status = 'done';
UPDATE tasks SET stage = 'backlog' WHERE role_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = tasks.id);

CREATE TABLE task_steps   (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ord INTEGER NOT NULL, title TEXT NOT NULL,
                           state TEXT NOT NULL,      -- pending | active | done
                           summary TEXT, run_id TEXT);
CREATE TABLE task_reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, reviewer TEXT NOT NULL, -- 'owner' | role id
                           verdict TEXT NOT NULL,    -- pass | changes | approved
                           findings TEXT,            -- JSON string[]
                           created_at TEXT NOT NULL);
```

Shared types: `TaskStage`, `Task.stage (TaskStage | null) / reviewerRoleId / stepSummary / nextStep / stageChangedAt`, `Role.reviewerRoleId`, `TaskStep`, `TaskReview`, and `Run.purpose` gains
`"review"`. `TaskSummary` gets `steps: { done, total }` and `lastReview` so the list needs no extra requests.

## API

One endpoint for owner moves, validated by a zod schema in `schemas.ts`:

```
POST /api/tasks/:id/actions
  { action: "start" }
  { action: "continue", text?: string }            // next step; default text is "Continue with: <nextStep>"
  { action: "review", roleId?: string }            // starts a read-only review run; roleId overrides the resolved reviewer
  { action: "request_changes", text: string }      // owner review; records a task_review
  { action: "fix" }                                // sends the latest findings to the author session
  { action: "approve", force?: boolean }           // force: approve even with open children
  { action: "close" } | { action: "reopen" } | { action: "backlog" }
```

All actions return 400 for plain chats, which have no stage. `PATCH /api/tasks/:id` accepts `reviewerRoleId`, and the role update
accepts `reviewerRoleId`. Both are validated against the project's roles. The response is 409 with a reason when `nextStage`
refuses the move, for example when the agent is still running. `PATCH {done}`
stays for one release and maps to `close` and `reopen`. A `task_updated` event is published as today. Stage changes also publish
`inbox_changed` because `needs_review` and `changes_requested` show in the Inbox.

## UI

### Project page: task board grouped by "whose move"

Replace the flat list with sections. Each section is collapsible and shows a count:

1. **Needs you**: `needs_review`, `changes_requested`, activity `waiting` (a question), `failed`, `interrupted`. Oldest first.
2. **Working**: activity `running` or `queued`, with the scheduler's wait reason for queued tasks.
3. **Up next**: `backlog`, sorted by emergency, priority, then age. The first one is marked **Next**, with a **Start** button.
4. **Approved**: tasks that are approved but not closed, for example while a merge is pending.
5. **Closed**: collapsed by default.
6. **Chats**: plain chats, as they are listed today (activity badge, Mark done / Reopen), with no stage.

Each row shows a **stage pill** (colour by owner: amber means you, blue means an agent, grey means nobody). Next to it are a small
activity dot, the step progress (`2/4`), the latest `stepSummary` or the question, and the review badge. Rows have **inline
actions** for the current stage, so most decisions need no click into the task:

| Stage / activity    | Inline actions                                         |
| ------------------- | ------------------------------------------------------ |
| `backlog`           | Start                                                  |
| `needs_review`      | Review with agent ▾ (role picker) · Approve · Continue |
| `changes_requested` | Fix · Open                                             |
| `waiting`           | Answer (opens the task at the question)                |
| `failed`            | Retry                                                  |
| `approved`          | Close                                                  |

The project header gets a one-line **"Next up"** banner. It shows the first "Needs you" item if there is one, otherwise the first
"Up next" task, with its main action. The banner answers "what should I do now?"

### Task page

- A **stage bar** under the title, `Backlog → In progress → Needs review → Approved → Closed`, with the current stage highlighted,
  and with in_review/changes_requested shown as a loop around "Needs review". The bar shows when the stage last changed.
- A **steps panel** when there is a plan: a checklist with each step's summary and a link to the run that finished it.
- A **review panel** with the latest review verdict and findings (file:line as links in the transcript), and the history in
  `task_reviews`.
- An **action bar** that replaces the current "Mark done" button. It shows the same actions as the row, and the composer placeholder
  changes with the stage ("Ask for changes…", "Continue with: …").
- Review runs show inline in the transcript under a "Review" header so they are not mistaken for author turns.

### Inbox

Inbox gains a "Ready for review" group (`needs_review`) and a "Changes requested" group, next to questions and proposals. The badge
count includes them.

## Optional automation (project setting, off by default)

- **Auto-review**: when a step ends, start a review run with the chosen reviewer role. The owner still approves.
- **Auto-continue on pass**: if the agent review passes and the step was `done` (not `complete`), continue with `nextStep`, up to N
  steps. This uses the existing usage budgets, so it cannot run away.
- **Start next when idle**: when a role has no running task, the scheduler may start the top `backlog` task of that role. This is
  the same as today's queue behaviour, but opt-in per project because some owners want to choose.

- **Hands-off delivery** (`autoApprove`): the owner delegates approval to the agent reviewer. When the latest review is an agent
  `pass` on the task's current checkpoint, the server approves the task and, with a managed baseline, integrates it exactly as the
  owner's Preview integration → Approve would, once no agent runs in the project (queued work there holds until it lands). A
  `changes` verdict sends the findings back to the author automatically, at most 3 times in a row. A failed integration (conflict,
  oversized diff, blocker) leaves the task in `needs_review` with a notice for the owner.
  After each integration the baseline is published to GitHub (see [WORKSPACES.md](WORKSPACES.md#github-publication-and-merge)). Agents
  of a hands-off project are told in their preamble to settle routine scope, evidence and acceptance questions themselves and to ask
  other departments with task blocks rather than owner-reviewed proposals.

Implemented as project settings `autoReview`, `autoContinueSteps` (0 to 20, 0 is off), `startNextWhenIdle` and `autoApprove`. The
count of automatic continues and fixes lives on the task (`autoContinues`) and resets whenever the owner sends a message or moves the
stage. Each agent review records the checkpoint it read (`task_reviews.reviewed_commit`): auto-review skips a finished step that
changed no files since a passed review, so a status question to a task in `needs_review` does not start another review.

**Pausing a project** (`automationPaused`, the Pause/Resume button in the project header) lets the owner put a project's work aside
to prioritize others. While paused, none of its queued role runs start, not even emergencies (the scheduler says why, and "Run anyway"
still starts one). None of the automation above acts. Daily company assignments are not created, and the coordinator neither starts
its backlog nor resumes its tasks. Running agents finish their current turn, and plain chats are unaffected. Resuming lets the queue
and automation continue.

## Rollout

1. `stages.ts` with a table test; migration and shared types; set `stage` in runner and routes; remove `done` from `TaskStatus`; the actions endpoint. The UI shows a stage pill only.
2. The `step` block in `blocks.ts` and the preamble; `stepSummary` and `nextStep`; the grouped project board with inline actions and the Next-up banner; Inbox groups.
3. Review runs: `purpose: "review"`, the read-only override, `base_commit` diffs, the `review` block, `task_reviews`, and the review panel.
   Also reviewer resolution (`reviewerRoleId` on tasks and roles), the reviewer picker in the row, task settings and the Studio role editor.
4. `plan` blocks and `task_steps`, plus the optional automation settings. Then Phase 3 workflows reuse `task_steps` for their gates.

Each phase gets API tests driving the fake agent. New `fake-claude.mjs` keywords are `step-done`, `step-complete`, `review-pass`
and `review-changes`. Playwright gets one test of the board flow: start → needs review → review with agent → fix → approve → close.

## Decisions

1. **Stages are for role tasks only.** Plain chats keep today's behaviour and have `stage = null`.
2. **`approved` and `closed` stay separate.** Phase 3 merges worktrees between the two.
3. **The default reviewer is the same role, in a fresh session.** The reviewer can be set per review, per task and per role
   (`reviewerRoleId`), so later seniority tiers (Junior → Senior), QA or department-lead review are configuration only. Phase 3's
   "Review by the reporting line" can fill the role default automatically.
