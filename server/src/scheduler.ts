import type { Effort, Provider } from "@ad/shared";

// Deciding which queued runs start is a pure function of this snapshot, so the rules can be tested
// as a table. The runner builds the snapshot from the database and its live processes.

export interface QueuedRun {
  runId: string;
  projectId: string;
  roleId: string;
  roleName: string;
  departmentId: string;
  canEdit: boolean;
  priority: number;
  emergency: boolean;
  forced: boolean;
  queuedAt: string;
  // What the run is expected to cost, to charge its department as it starts.
  estimateUsd: number;
  // The provider it would run on, for the coordinator's holds.
  provider?: Provider;
}

// The coordinator holds a provider's queued work: below minPriority, or all of it when null.
export interface ProviderHold {
  minPriority: number | null;
  reason: string;
}

export interface ActiveRun {
  runId: string;
  departmentId: string | null;
  canEdit: boolean;
}

export interface DepartmentState {
  name: string;
  weight: number;
  budgetUsd: number | null;
  // Spend over the last 24 hours plus estimates for its runs still going.
  spendUsd: number;
}

export interface SchedulerState {
  maxConcurrent: number;
  budgetUsd: number | null;
  spendUsd: number;
  departments: Map<string, DepartmentState>;
  // Agents of each role that are not paused and not working.
  freeAgents: Map<string, string[]>;
  // Roles with at least one agent that is not paused.
  staffedRoles: Set<string>;
  // Projects with an open emergency task.
  frozenProjects: Set<string>;
  active: ActiveRun[];
  queued: QueuedRun[];
  providerHolds?: Map<Provider, ProviderHold>;
}

export interface Plan {
  start: { runId: string; agentId: string }[];
  // Why each run that stays queued is waiting.
  waiting: Map<string, string>;
}

// Rough cost of one run by effort when a role has no history yet. Only used to share compute
// between departments while runs are still going, never shown as a price.
export const EFFORT_COST_GUESS: Record<Effort, number> = { minimal: 0.03, low: 0.05, medium: 0.15, high: 0.4, xhigh: 0.8, max: 1.5 };

const money = (n: number) => `$${n.toFixed(2)}`;

// Held runs wait on a rule the owner can override with "run anyway" (a budget, an emergency),
// unlike a busy agent or a full slot, which clear up by themselves.
export const isHeldReason = (reason: string) => /daily budget|emergency task|^Coordinator:/.test(reason);

// Queue order inside a department, and among emergencies: higher priority first, then older.
export function byPriority(a: QueuedRun, b: QueuedRun): number {
  return b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt) || a.runId.localeCompare(b.runId);
}

export function plan(input: SchedulerState): Plan {
  const freeAgents = new Map([...input.freeAgents].map(([role, agents]) => [role, [...agents]]));
  const spend = new Map([...input.departments].map(([id, d]) => [id, d.spendUsd]));
  const writers = new Set(input.active.filter((a) => a.canEdit && a.departmentId).map((a) => a.departmentId!));
  let running = input.active.length;
  let globalSpend = input.spendUsd;
  const start: Plan["start"] = [];
  let queue = [...input.queued].sort(byPriority);

  // Null when the run may start now; otherwise why not. Emergencies skip the budget, the slot
  // limit and the freeze (they are the reason for it), but still need an agent and must not edit
  // files alongside another writer of their department.
  const blocker = (q: QueuedRun): string | null => {
    const dept = input.departments.get(q.departmentId);
    const deptName = dept?.name ?? "Its department";
    if (!input.staffedRoles.has(q.roleId)) return `No ${q.roleName} agent is available. Hire one or unpause one in the Studio.`;
    if (!freeAgents.get(q.roleId)?.length) return `Every ${q.roleName} agent is busy.`;
    if (q.canEdit && writers.has(q.departmentId)) return `${deptName} already has an agent editing files; one at a time per department.`;
    if (q.emergency) return null;
    if (!q.forced && input.frozenProjects.has(q.projectId)) return "Paused while an emergency task in this project is open.";
    if (!q.forced && dept?.budgetUsd != null && (spend.get(q.departmentId) ?? 0) >= dept.budgetUsd)
      return `${deptName} reached its daily budget (${money(spend.get(q.departmentId) ?? 0)} of ${money(dept.budgetUsd)}).`;
    if (!q.forced && input.budgetUsd != null && globalSpend >= input.budgetUsd)
      return `The daily budget is reached (${money(globalSpend)} of ${money(input.budgetUsd)}).`;
    const hold = q.provider ? input.providerHolds?.get(q.provider) : undefined;
    if (!q.forced && hold && (hold.minPriority === null || q.priority < hold.minPriority)) return hold.reason;
    if (running >= input.maxConcurrent) return `Waiting for a free slot (${running} of ${input.maxConcurrent} agents running).`;
    return null;
  };

  // Departments share slots by weight: the next one to start is the department that spent least
  // per unit of weight (spend / weight), so a weight-6 department gets about twice the compute of a
  // weight-3 one. Inside the department, the highest priority goes first.
  const share = (q: QueuedRun) => (spend.get(q.departmentId) ?? 0) / Math.max(1, input.departments.get(q.departmentId)?.weight ?? 1);

  for (;;) {
    const ready = queue.filter((q) => blocker(q) === null);
    if (ready.length === 0) break;
    const emergencies = ready.filter((q) => q.emergency);
    const next = emergencies.length
      ? emergencies[0]!
      : ready.reduce((best, q) => {
          const diff = share(q) - share(best);
          return diff < 0 || (diff === 0 && byPriority(q, best) < 0) ? q : best;
        });
    const agentId = freeAgents.get(next.roleId)!.shift()!;
    start.push({ runId: next.runId, agentId });
    running++;
    if (next.canEdit) writers.add(next.departmentId);
    spend.set(next.departmentId, (spend.get(next.departmentId) ?? 0) + next.estimateUsd);
    globalSpend += next.estimateUsd;
    queue = queue.filter((q) => q !== next);
  }

  const waiting = new Map<string, string>();
  for (const q of queue) waiting.set(q.runId, blocker(q) ?? "Waiting for a free slot.");
  return { start, waiting };
}
