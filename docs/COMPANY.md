# Company daily reviews

The project's Company tab stores a game description, genre, references, audience, local playtest instructions, and daily UTC hour. Daily reviews are opt-in; saving a disabled brief does not staff roles or create work.

When enabled, the service reuses or creates a Game Director and QA Player, adding one agent only if the role is unstaffed. Existing roles and paused agents are preserved. These are initial review seats, not automatic hiring and firing based on project needs.

`server/src/company.ts` checks once at startup and every minute. It creates at most one observation task per role per UTC day after the configured hour, subject to normal runner staffing, quota, budget, dependency, and restart constraints. The dashboard must be running; after downtime it schedules only the current day. A prior queued, running, waiting, or undispatched assignment blocks another of the same kind. A finished or failed assignment permits the next day's review. Disabling stops future creation and dispatch; already queued or running work remains available in Tasks.

Assignment tasks follow their role's edit permission. A read-only role (the default staffing) returns the report only in its reply. A role that can edit gets a writable task and also saves the report as `<department folder>/reports/<kind>-daily-<day>.md`, so a reviewer can check a committed file. Grant edit access on the role before the next daily assignment is created; an existing task keeps its own setting.

The append-only database migration adds `companies` and `company_assignments`. All SQL lives in Store. Assignment creation and task creation are atomic. The durable outbox keeps the prompt snapshot; message/run creation and the dispatched marker commit together. Restart recovery does not resend assignments that already have runs. Deleting a task keeps its daily slot as a tombstone; deleting the project cascades the company data. Scheduling errors appear on the Company tab. Its assignment list polls every 30 seconds and links to the retained task transcripts.

Assignments request the build/commit, played scenarios, evidence, reproducible bugs, and separate AI assessments of fun and usability. Director reports additionally request priorities, designs, staffing recommendations, milestones, and exit criteria. Tasks are read-only even when reusing a writing role. Interactive play depends on the project's local setup and available agent tools; instructions require an explicit NOT PLAYED report when it cannot be performed. A successful run is not evidence of successful gameplay, and AI assessment is not human player research.

This is the first company automation phase. Existing review, delegation, and delivery gates remain in place. Reports do not yet feed a structured evidence store or automatically enact plans or staffing changes. Prompts require owner approval before spending or live-service downtime, but this is not a technical action-classification or approval enforcement layer. Existing configured provider usage and budget controls still apply.

Remaining phases:

- Give the director validated, bounded actions for role creation, hiring, retirement, task prioritization, and deduplicated backlog changes.
- Carry the brief into all company work and implement a recurring planning cycle using current task, design, feedback, and milestone state.
- Capture structured playtest evidence and reports, route findings into work, and let the director consume QA results.
- Implement approval routing for money and downtime while resolving ordinary decisions and recovery without owner supervision. The [inbox steward](STEWARD.md) now resolves ordinary inbox decisions; money and downtime are escalated by its prompt, not a technical classification.
- Verify the full brief-to-playable-build loop, including delivery, failed playtests, quota exhaustion, and restart recovery.
