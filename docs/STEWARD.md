# Inbox steward

The inbox steward is an agent role ("Inbox Steward", read-only, in Leadership) that sees a project's inbox before the owner. It decides what it can on the owner's behalf and escalates the rest with a reason. Turn it on per project in Settings ("Inbox steward"). Migration 14 turns it on for projects that already use hands-off delivery.

## Flow

1. `server/src/steward.ts` runs a pass on every `inbox_changed` / `run_updated` push and once a minute. For each steward project it collects the waiting items (questions, proposals, task requests, finished steps, requested changes, held and blocked runs), skips its own triage tasks, and routes up to 12 new items into one triage task (`Inbox triage: N items`, priority 10). Only one triage per project runs at a time; the scheduler, budgets, provider routing and pauses apply as for any role task.
2. The steward ends its reply with one `decision` block per item: `{"item": "<key>", "action": "...", "text": "...", "reason": "..."}`. `Studio.afterReply` only records decisions for items of that triage task; nothing is applied while the run is active.
3. When the triage run has ended, the next pass applies each decision through the owner's own paths (`Studio.answer`, `acceptProposal`, `approveHandoff`, `Runner.stageAction`, `startReview`), then closes the triage task. Items without a decision, with an action not allowed for their kind, or whose action fails are escalated with the reason. Items resolved elsewhere meanwhile are marked handled.

Item keys come from `inboxKeys` in `shared/src/steward.ts`; they change when the item does (a new question, a later review), so a changed item is triaged again. State is in `steward_items` (all SQL in `store.ts`).

## What the steward may do

| Item              | Actions                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question          | answer (sent as "Answer from the inbox steward, on the owner's behalf"), escalate                                                                                |
| Design proposal   | accept (the decision log says "accepted by the inbox steward"), reject, escalate                                                                                 |
| Task request      | approve, reject, escalate                                                                                                                                        |
| Finished step     | continue, review (agent review), request_changes, approve (only after a passed agent review of the current checkpoint), close (read-only reports only), escalate |
| Changes requested | fix, escalate                                                                                                                                                    |
| Held / blocked    | wait, escalate. Run anyway overrides a budget or baseline the owner set, so it stays the owner's.                                                                |

Its brief tells it to escalate only money, irreversible deletion, credentials, legal or licensing, publishing outside the repository, open and costly game-direction choices, or missing information. That policy is in the prompt; the table above is what the server enforces.

## The owner's inbox

On a steward project the inbox shows only escalated items, each with the steward's reason, plus "With the inbox steward" (being triaged, or not picked up yet) and "Recently handled by the inbox steward". Alerts and the inbox count cover only escalated items. The steward's own questions and held runs go straight to the owner. Turning the steward off returns every waiting item to the owner. A paused project keeps its items with the steward until it resumes.

## Limits

- The steward reads the item summary in its prompt plus the repository; it does not see diffs unless it reads the task's worktree, which is why approving needs a passed agent review.
- The steward's answers are not appended to `design/decisions.md` (accepted proposals are, as for the owner).
- A failed triage run escalates its items rather than retrying.
