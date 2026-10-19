import type {
  CompanyConfig,
  CompanyView,
  WorkspaceCleanupPreview,
  RestartStatus,
  BaselinePreview,
  DeliveryView,
  ProjectBaseline,
  DeliveryPlanPreview,
  ModelCatalog,
  Agent,
  AddFeedbackBody,
  ApproveHandoffBody,
  ClaudeCheck,
  Compute,
  CoordinatorConfig,
  CoordinatorView,
  QuotaReadingBody,
  CreateDepartmentBody,
  CreateProjectBody,
  CreateRoleBody,
  CreateTaskBody,
  Department,
  DesignDoc,
  DocDetail,
  FeedbackItem,
  Inbox,
  Message,
  Project,
  Proposal,
  Role,
  Run,
  Settings,
  StampedEvent,
  Studio,
  Task,
  TaskAction,
  TaskDetail,
  TaskWorkspace,
  TaskSummary,
  UpdateAgentBody,
  UpdateDepartmentBody,
  UpdateProjectBody,
  UpdateRoleBody,
  UpdateSettingsBody,
  UpdateTaskBody,
} from "@ad/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // No content type without a body: the server rejects an empty JSON body.
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Request failed (${res.status})`, res.status, data);
  return data as T;
}

type Saved = { commitError: string | null };

export const api = {
  company: (id: string) => request<CompanyView>("GET", `/api/projects/${id}/company`),
  saveCompany: (id: string, config: CompanyConfig) => request<CompanyView>("PUT", `/api/projects/${id}/company`, config),
  restartStatus: () => request<RestartStatus>("GET", "/api/server/restart"),
  requestRestart: () => request<RestartStatus>("POST", "/api/server/restart/request"),
  cancelRestart: () => request<RestartStatus>("POST", "/api/server/restart/cancel"),
  confirmRestart: () => request<{ restarting: boolean }>("POST", "/api/server/restart/confirm"),
  delivery: (id: string) => request<DeliveryView>("GET", `/api/projects/${id}/delivery`),
  previewDeliveryPlan: (id: string) => request<DeliveryPlanPreview>("POST", `/api/projects/${id}/delivery/plan`),
  approveDeliveryPlan: (id: string, previewId: string) => request<DeliveryPlanPreview>("POST", `/api/projects/${id}/delivery/plan/approve`, { previewId }),
  enableDelivery: (id: string) => request<{ enabled: boolean }>("POST", `/api/projects/${id}/delivery/enable`),
  previewBaseline: (id: string, paths: string[]) => request<BaselinePreview>("POST", `/api/projects/${id}/delivery/snapshot`, { paths }),
  previewIntegration: (id: string, taskId: string) => request<BaselinePreview>("POST", `/api/projects/${id}/delivery/integrate`, { taskId }),
  approveBaseline: (id: string, previewId: string) => request<ProjectBaseline>("POST", `/api/projects/${id}/delivery/approve`, { previewId }),
  models: () => request<ModelCatalog>("GET", "/api/models"),
  settings: () => request<Settings>("GET", "/api/settings"),
  updateSettings: (body: UpdateSettingsBody) => request<Settings>("PATCH", "/api/settings", body),
  checkCodex: () => request<ClaudeCheck>("POST", "/api/settings/check-codex"),
  checkClaude: () => request<ClaudeCheck>("POST", "/api/settings/check-claude"),

  projects: () => request<Project[]>("GET", "/api/projects"),
  project: (id: string) => request<Project>("GET", `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: UpdateProjectBody) => request<Project>("PATCH", `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<void>("DELETE", `/api/projects/${id}`),

  tasks: (projectId: string) => request<TaskSummary[]>("GET", `/api/projects/${projectId}/tasks`),
  task: (id: string) => request<TaskDetail>("GET", `/api/tasks/${id}`),
  checkpointTask: (id: string) => request<TaskWorkspace>("POST", `/api/tasks/${id}/checkpoint`),
  previewWorkspaceCleanup: (id: string) => request<WorkspaceCleanupPreview>("GET", `/api/tasks/${id}/workspace-cleanup`),
  previewProjectCleanup: (id: string) => request<(WorkspaceCleanupPreview & { title: string })[]>("GET", `/api/projects/${id}/workspace-cleanup`),
  cleanupWorkspace: (id: string) => request<WorkspaceCleanupPreview>("POST", `/api/tasks/${id}/workspace-cleanup`),
  publishTask: (id: string) => request<TaskWorkspace>("POST", `/api/tasks/${id}/publish`),
  mergeTask: (id: string) => request<TaskWorkspace>("POST", `/api/tasks/${id}/merge`),
  prepareHandoff: (id: string) => request<{ message: Message; run: Run }>("POST", `/api/tasks/${id}/prepare-handoff`),
  compactTask: (id: string, summary: string) => request<Task>("POST", `/api/tasks/${id}/compact`, { summary }),
  createTask: (projectId: string, body: CreateTaskBody) => request<Task>("POST", `/api/projects/${projectId}/tasks`, body),
  updateTask: (id: string, body: UpdateTaskBody) => request<Task>("PATCH", `/api/tasks/${id}`, body),
  taskAction: (id: string, body: TaskAction) => request<Task>("POST", `/api/tasks/${id}/actions`, body),
  deleteTask: (id: string) => request<void>("DELETE", `/api/tasks/${id}`),
  send: (taskId: string, text: string) => request<{ message: Message; run: Run }>("POST", `/api/tasks/${taskId}/messages`, { text }),
  answer: (taskId: string, text: string, record: boolean) => request<{ run: Run } & Saved>("POST", `/api/tasks/${taskId}/answer`, { text, record }),

  runEvents: (runId: string) => request<StampedEvent[]>("GET", `/api/runs/${runId}/events`),
  stopRun: (runId: string) => request<{ ok: boolean }>("POST", `/api/runs/${runId}/stop`),
  retryRun: (runId: string) => request<Run>("POST", `/api/runs/${runId}/retry`),
  forceRun: (runId: string) => request<Run>("POST", `/api/runs/${runId}/force`),

  studio: (projectId: string) => request<Studio>("GET", `/api/projects/${projectId}/studio`),
  applyTemplate: (projectId: string) => request<Studio>("POST", `/api/projects/${projectId}/studio/template`),
  createDepartment: (projectId: string, body: CreateDepartmentBody) => request<Department>("POST", `/api/projects/${projectId}/departments`, body),
  updateDepartment: (id: string, body: UpdateDepartmentBody) => request<Department>("PATCH", `/api/departments/${id}`, body),
  deleteDepartment: (id: string) => request<void>("DELETE", `/api/departments/${id}`),
  createRole: (projectId: string, body: CreateRoleBody) => request<Role>("POST", `/api/projects/${projectId}/roles`, body),
  updateRole: (id: string, body: UpdateRoleBody) => request<Role>("PATCH", `/api/roles/${id}`, body),
  deleteRole: (id: string) => request<void>("DELETE", `/api/roles/${id}`),
  hire: (roleId: string) => request<Agent>("POST", `/api/roles/${roleId}/agents`, {}),
  updateAgent: (id: string, body: UpdateAgentBody) => request<Agent>("PATCH", `/api/agents/${id}`, body),
  removeAgent: (id: string) => request<void>("DELETE", `/api/agents/${id}`),

  docs: (projectId: string) => request<DesignDoc[]>("GET", `/api/projects/${projectId}/docs`),
  doc: (projectId: string, path: string) => request<DocDetail>("GET", `/api/projects/${projectId}/docs/file?path=${encodeURIComponent(path)}`),
  saveDoc: (projectId: string, path: string, content: string) => request<Saved>("PUT", `/api/projects/${projectId}/docs/file`, { path, content }),

  inbox: () => request<Inbox>("GET", "/api/inbox"),
  acceptProposal: (id: string, body?: string) =>
    request<{ proposal: Proposal } & Saved>("POST", `/api/proposals/${id}/accept`, body === undefined ? {} : { body }),
  rejectProposal: (id: string, reason?: string) => request<Proposal>("POST", `/api/proposals/${id}/reject`, reason ? { reason } : {}),
  approveHandoff: (id: string, body: ApproveHandoffBody) => request<Task>("POST", `/api/handoffs/${id}/approve`, body),
  rejectHandoff: (id: string) => request<void>("POST", `/api/handoffs/${id}/reject`),

  compute: () => request<Compute>("GET", "/api/compute"),

  coordinator: () => request<CoordinatorView>("GET", "/api/coordinator"),
  saveCoordinatorConfig: (config: CoordinatorConfig) => request<CoordinatorView>("PUT", "/api/coordinator/config", config),
  addQuotaReading: (body: QuotaReadingBody) => request<CoordinatorView>("POST", "/api/coordinator/readings", body),
  refreshUsage: () => request<CoordinatorView>("POST", "/api/coordinator/refresh", {}),
  applyCoordinatorAction: (key: string) => request<CoordinatorView>("POST", "/api/coordinator/apply", { key }),

  feedback: (projectId: string) => request<FeedbackItem[]>("GET", `/api/projects/${projectId}/feedback`),
  addFeedback: (projectId: string, body: AddFeedbackBody) => request<FeedbackItem[]>("POST", `/api/projects/${projectId}/feedback`, body),
  updateFeedback: (id: string, status: FeedbackItem["status"]) => request<FeedbackItem>("PATCH", `/api/feedback/${id}`, { status }),
  deleteFeedback: (id: string) => request<void>("DELETE", `/api/feedback/${id}`),
  triage: (projectId: string, itemIds: string[], roleId: string) => request<Task>("POST", `/api/projects/${projectId}/feedback/triage`, { itemIds, roleId }),
};

export const keys = {
  company: (id: string) => ["company", id] as const,
  settings: ["settings"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  tasks: (projectId: string) => ["tasks", projectId] as const,
  task: (id: string) => ["task", id] as const,
  runEvents: (runId: string) => ["run-events", runId] as const,
  studio: (projectId: string) => ["studio", projectId] as const,
  docs: (projectId: string) => ["docs", projectId] as const,
  doc: (projectId: string, path: string) => ["doc", projectId, path] as const,
  inbox: ["inbox"] as const,
  compute: ["compute"] as const,
  coordinator: ["coordinator"] as const,
  feedback: (projectId: string) => ["feedback", projectId] as const,
};
