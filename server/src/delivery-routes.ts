import path from "node:path";
import { z } from "zod";
import { requiredPaths } from "@ad/shared";
import type { FastifyInstance } from "fastify";
import { Delivery } from "./delivery.ts";
import { DeliveryPlan } from "./delivery-plan.ts";
import { parse } from "./http.ts";
import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";

export function registerDeliveryRoutes(app: FastifyInstance, store: Store, runner: Runner, dataDir: string) {
  const delivery = new Delivery(store, runner, path.join(dataDir, "delivery"));
  const plan = new DeliveryPlan(store, runner);
  runner.deliver = (projectId, taskId) => delivery.autoApprove(projectId, taskId);
  app.post<{ Params: { id: string } }>("/api/projects/:id/delivery/plan", (request) => plan.preview(request.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/delivery/plan/approve", (request, reply) => {
    const body = parse(z.object({ previewId: z.string().uuid() }), request.body, reply);
    if (body) return plan.approve(request.params.id, body.previewId);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/delivery/enable", (request) => plan.enable(request.params.id));
  app.get<{ Params: { id: string } }>("/api/projects/:id/delivery", (request) => delivery.view(request.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/delivery/snapshot", (request, reply) => {
    const body = parse(z.object({ paths: requiredPaths }), request.body, reply);
    if (body) return delivery.snapshot(request.params.id, body.paths);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/delivery/integrate", (request, reply) => {
    const body = parse(z.object({ taskId: z.string().uuid() }), request.body, reply);
    if (body) return delivery.integrate(request.params.id, body.taskId);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/delivery/approve", (request, reply) => {
    const body = parse(z.object({ previewId: z.string().uuid() }), request.body, reply);
    if (body) return delivery.approve(request.params.id, body.previewId);
  });
}
