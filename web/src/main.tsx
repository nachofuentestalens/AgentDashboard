import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, useParams } from "react-router";
import { Layout } from "./components/Layout.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";
import "./index.css";

// Live updates keep the cache fresh, so queries do not refetch on focus.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

// Remount per project so forms start from that project's values.
function ProjectRoute({ tab }: { tab: "tasks" | "settings" }) {
  const { projectId } = useParams();
  return <ProjectPage key={projectId} tab={tab} />;
}

function TaskRoute() {
  const { taskId } = useParams();
  return <TaskPage key={taskId} />;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/projects/:projectId", element: <ProjectRoute tab="tasks" /> },
      { path: "/projects/:projectId/settings", element: <ProjectRoute tab="settings" /> },
      { path: "/tasks/:taskId", element: <TaskRoute /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <HomePage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
