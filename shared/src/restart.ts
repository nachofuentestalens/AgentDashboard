export interface RestartParticipant {
  taskId: string;
  title: string;
  runId: string;
  handoffRunId: string | null;
  state: "working" | "saving" | "ready" | "error";
  error: string | null;
}

export interface RestartStatus {
  supported: boolean;
  phase: "idle" | "preparing" | "ready" | "restarting";
  participants: RestartParticipant[];
  error: string | null;
}
