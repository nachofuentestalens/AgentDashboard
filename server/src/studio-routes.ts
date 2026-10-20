import type { FastifyInstance } from "fastify";
import {
  dismissAlertBody,
  acceptProposalBody,
  addFeedbackBody,
  answerBody,
  approveHandoffBody,
  createDepartmentBody,
  createRoleBody,
  DEFAULT_PRIORITY,
  hireAgentBody,
  rejectBody,
  saveDocBody,
  triageFeedbackBody,
  updateAgentBody,
  updateDepartmentBody,
  updateFeedbackBody,
  updateRoleBody,
  type DocDetail,
} from "@ad/shared";
import type { Bus } from "./bus.ts";
import { docHistory, listDocs, readDoc, saveDocs } from "./docs.ts";
import { DECISIONS_DOC } from "./folders.ts";
import { HttpError, parse } from "./http.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";
import type { Studio } from "./studio.ts";

type Params = { Params: { id: string } };

// Departments, roles and agents; design documents; the inbox; compute; feedback.
export function registerStudioRoutes(app: FastifyInstance, ctx: { store: Store; bus: Bus; runner: Runner; studio: Studio }) {
  const { store, bus, runner, studio } = ctx;

  const project = (id: string) => {
    const p = store.getProject(id);
    if (!p) throw new HttpError("Project not found.", 404);
    return p;
  };
  const changed = (projectId: string) => {
    bus.publish({ type: "studio_changed", projectId });
    runner.tick();
  };

  // ---- studio

  app.get<Params>("/api/projects/:id/studio", async (request) => {
    project(request.params.id);
    return studio.view(request.params.id);
  });

  app.post<Params>("/api/projects/:id/studio/template", async (request, reply) => {
    project(request.params.id);
    return reply.code(201).send(studio.applyTemplate(request.params.id));
  });

  app.post<Params>("/api/projects/:id/departments", async (request, reply) => {
    const body = parse(createDepartmentBody, request.body, reply);
    if (!body) return;
    project(request.params.id);
    const dept = store.createDepartment({
      projectId: request.params.id,
      name: body.name,
      color: body.color ?? "#7d849c",
      weight: body.weight ?? 3,
      dailyBudgetUsd: body.dailyBudgetUsd ?? null,
      folders: body.folders ?? [
        body.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "work",
      ],
      autonomy: body.autonomy ?? "ask",
    });
    changed(dept.projectId);
    return reply.code(201).send(dept);
  });

  app.patch<Params>("/api/departments/:id", async (request, reply) => {
    const body = parse(updateDepartmentBody, request.body, reply);
    if (!body) return;
    const dept = store.updateDepartment(request.params.id, body);
    if (!dept) throw new HttpError("Department not found.", 404);
    changed(dept.projectId);
    return dept;
  });

  app.delete<Params>("/api/departments/:id", async (request, reply) => {
    studio.deleteDepartment(request.params.id);
    return reply.code(204).send();
  });

  app.post<Params>("/api/projects/:id/roles", async (request, reply) => {
    const body = parse(createRoleBody, request.body, reply);
    if (!body) return;
    project(request.params.id);
    const dept = store.getDepartment(body.departmentId);
    if (!dept || dept.projectId !== request.params.id) throw new HttpError("That department is not part of this project.", 400);
    if (store.findRoleByName(request.params.id, body.name)) throw new HttpError(`There is already a role called "${body.name}".`, 409);
    if (body.reviewerRoleId && store.getRole(body.reviewerRoleId)?.projectId !== request.params.id)
      throw new HttpError("The reviewer must be a role in this project.", 400);
    const role = store.createRole({
      projectId: request.params.id,
      departmentId: dept.id,
      name: body.name,
      brief: body.brief ?? "",
      provider: body.provider ?? null,
      model: body.model ?? null,
      effort: body.effort ?? null,
      canEdit: body.canEdit ?? false,
      allowedTools: body.allowedTools ?? null,
      contextDocs: body.contextDocs ?? [],
      reviewerRoleId: body.reviewerRoleId ?? null,
    });
    studio.hire(role.id);
    return reply.code(201).send(role);
  });

  app.patch<Params>("/api/roles/:id", async (request, reply) => {
    const body = parse(updateRoleBody, request.body, reply);
    if (!body) return;
    const current = store.getRole(request.params.id);
    if (!current) throw new HttpError("Role not found.", 404);
    if (body.departmentId) {
      const dept = store.getDepartment(body.departmentId);
      if (!dept || dept.projectId !== current.projectId) throw new HttpError("That department is not part of this project.", 400);
    }
    // Agents name roles in task blocks, so names stay unique within a project.
    const clash = body.name ? store.findRoleByName(current.projectId, body.name) : null;
    if (clash && clash.id !== current.id) throw new HttpError(`There is already a role called "${body.name}".`, 409);
    if (body.reviewerRoleId && store.getRole(body.reviewerRoleId)?.projectId !== current.projectId)
      throw new HttpError("The reviewer must be a role in this project.", 400);
    const role = store.updateRole(current.id, body)!;
    changed(role.projectId);
    return role;
  });

  app.delete<Params>("/api/roles/:id", async (request, reply) => {
    studio.deleteRole(request.params.id);
    return reply.code(204).send();
  });

  app.post<Params>("/api/roles/:id/agents", async (request, reply) => {
    const body = parse(hireAgentBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(studio.hire(request.params.id, body.name));
  });

  app.patch<Params>("/api/agents/:id", async (request, reply) => {
    const body = parse(updateAgentBody, request.body, reply);
    if (!body) return;
    const agent = store.updateAgent(request.params.id, body);
    if (!agent) throw new HttpError("Agent not found.", 404);
    const role = store.getRole(agent.roleId);
    if (role) changed(role.projectId);
    return agent;
  });

  app.delete<Params>("/api/agents/:id", async (request, reply) => {
    studio.removeAgent(request.params.id);
    return reply.code(204).send();
  });

  // ---- design documents

  app.get<Params>("/api/projects/:id/docs", async (request) => {
    const p = project(request.params.id);
    return listDocs(p.repoPath, store.listDepartments(p.id));
  });

  app.get<Params & { Querystring: { path?: string } }>("/api/projects/:id/docs/file", async (request) => {
    const p = project(request.params.id);
    const found = readDoc(p.repoPath, request.query.path ?? "", store.listDepartments(p.id));
    if (!found) throw new HttpError("Document not found.", 404);
    const detail: DocDetail = { ...found, history: await docHistory(p.repoPath, found.doc.path) };
    return detail;
  });

  app.put<Params>("/api/projects/:id/docs/file", async (request, reply) => {
    const body = parse(saveDocBody, request.body, reply);
    if (!body) return;
    const p = project(request.params.id);
    if (body.path.replace(/\\/g, "/") === DECISIONS_DOC)
      throw new HttpError("The decision log is appended by the dashboard; edit it in your editor if you must.", 400);
    const saved = await saveDocs(p.repoPath, { files: [{ path: body.path, content: body.content }], message: body.message || `Edit ${body.path}` });
    bus.publish({ type: "docs_changed", projectId: p.id });
    return saved;
  });

  // ---- inbox

  app.get("/api/inbox", async () => studio.inbox());

  app.post<Params>("/api/projects/:id/steward/alerts/dismiss", async (request, reply) => {
    const body = parse(dismissAlertBody, request.body, reply);
    if (!body) return;
    if (!store.clearStewardAlert(request.params.id, body.key, "Dismissed by the owner.")) throw new HttpError("That alert is not waiting.", 404);
    bus.publish({ type: "inbox_changed" });
    return reply.code(204).send();
  });

  app.post<Params>("/api/proposals/:id/accept", async (request, reply) => {
    const body = parse(acceptProposalBody, request.body, reply);
    if (!body) return;
    return studio.acceptProposal(request.params.id, body.body);
  });

  app.post<Params>("/api/proposals/:id/reject", async (request, reply) => {
    const body = parse(rejectBody, request.body, reply);
    if (!body) return;
    return studio.rejectProposal(request.params.id, body.reason);
  });

  app.post<Params>("/api/handoffs/:id/approve", async (request, reply) => {
    const body = parse(approveHandoffBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(studio.approveHandoff(request.params.id, body));
  });

  app.post<Params>("/api/handoffs/:id/reject", async (request, reply) => {
    studio.rejectHandoff(request.params.id);
    return reply.code(204).send();
  });

  app.post<Params>("/api/tasks/:id/answer", async (request, reply) => {
    const body = parse(answerBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(await studio.answer(request.params.id, body.text, body.record ?? false));
  });

  // ---- compute

  app.get("/api/compute", async () => studio.compute());

  // ---- feedback

  app.get<Params>("/api/projects/:id/feedback", async (request) => {
    project(request.params.id);
    return store.listFeedback(request.params.id);
  });

  app.post<Params>("/api/projects/:id/feedback", async (request, reply) => {
    const body = parse(addFeedbackBody, request.body, reply);
    if (!body) return;
    project(request.params.id);
    const items = store.addFeedback(request.params.id, body.items);
    bus.publish({ type: "feedback_changed", projectId: request.params.id });
    return reply.code(201).send(items);
  });

  app.patch<Params>("/api/feedback/:id", async (request, reply) => {
    const body = parse(updateFeedbackBody, request.body, reply);
    if (!body) return;
    const item = store.updateFeedback(request.params.id, body);
    if (!item) throw new HttpError("Feedback not found.", 404);
    bus.publish({ type: "feedback_changed", projectId: item.projectId });
    return item;
  });

  app.delete<Params>("/api/feedback/:id", async (request, reply) => {
    const item = store.getFeedback(request.params.id);
    if (!item) throw new HttpError("Feedback not found.", 404);
    store.deleteFeedback(item.id);
    bus.publish({ type: "feedback_changed", projectId: item.projectId });
    return reply.code(204).send();
  });

  app.post<Params>("/api/projects/:id/feedback/triage", async (request, reply) => {
    const body = parse(triageFeedbackBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(studio.triage(request.params.id, body.itemIds, body.roleId, body.priority ?? DEFAULT_PRIORITY));
  });
}
