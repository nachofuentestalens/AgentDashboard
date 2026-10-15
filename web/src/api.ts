import type {
  ClaudeCheck,
  CreateProjectBody,
  CreateTaskBody,
  Message,
  Project,
  Run,
  Settings,
  StampedEvent,
  Task,
  TaskDetail,
  TaskSummary,
  UpdateProjectBody,
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

export const api = {
  settings: () => request<Settings>("GET", "/api/settings"),
  updateSettings: (body: UpdateSettingsBody) => request<Settings>("PATCH", "/api/settings", body),
  checkClaude: () => request<ClaudeCheck>("POST", "/api/settings/check-claude"),

  projects: () => request<Project[]>("GET", "/api/projects"),
  project: (id: string) => request<Project>("GET", `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: UpdateProjectBody) => request<Project>("PATCH", `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<void>("DELETE", `/api/projects/${id}`),

  tasks: (projectId: string) => request<TaskSummary[]>("GET", `/api/projects/${projectId}/tasks`),
  task: (id: string) => request<TaskDetail>("GET", `/api/tasks/${id}`),
  createTask: (projectId: string, body: CreateTaskBody) => request<Task>("POST", `/api/projects/${projectId}/tasks`, body),
  updateTask: (id: string, body: UpdateTaskBody) => request<Task>("PATCH", `/api/tasks/${id}`, body),
  deleteTask: (id: string) => request<void>("DELETE", `/api/tasks/${id}`),
  send: (taskId: string, text: string) => request<{ message: Message; run: Run }>("POST", `/api/tasks/${taskId}/messages`, { text }),

  runEvents: (runId: string) => request<StampedEvent[]>("GET", `/api/runs/${runId}/events`),
  stopRun: (runId: string) => request<{ ok: boolean }>("POST", `/api/runs/${runId}/stop`),
  retryRun: (runId: string) => request<Run>("POST", `/api/runs/${runId}/retry`),
};

export const keys = {
  settings: ["settings"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  tasks: (projectId: string) => ["tasks", projectId] as const,
  task: (id: string) => ["task", id] as const,
  runEvents: (runId: string) => ["run-events", runId] as const,
};
