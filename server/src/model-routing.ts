import { z } from "zod";
import { EFFORT_LEVELS, PROVIDER_EFFORTS, type Choice, type ModelOption, type Provider } from "@ad/shared";

const reviewSchema = z
  .object({
    complexity: z.enum(["simple", "moderate", "complex"]),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._\-[\]]{1,64}$/)
      .nullable(),
    effort: z.enum(EFFORT_LEVELS),
    reason: z.string().trim().min(1).max(600),
    action: z.enum(["continue", "switch"]),
    nextStep: z.string().trim().max(2000).optional(),
  })
  .strict();
export type ModelReview = z.infer<typeof reviewSchema>;

export function parseModelReview(text: string): ModelReview | null {
  const blocks = [...text.matchAll(/```model-review\s*\n([\s\S]*?)\n```/g)];
  const body = blocks.at(-1)?.[1];
  if (!body || body.length > 4000) return null;
  try {
    return reviewSchema.parse(JSON.parse(body));
  } catch {
    return null;
  }
}

export function validateModelReview(review: ModelReview, provider: Provider, models: ModelOption[], current: Choice): string | null {
  if (!PROVIDER_EFFORTS[provider].includes(review.effort)) return "The recommended effort is not supported by this provider.";
  if (review.model !== current.model && (review.model === null || !models.some((m) => m.id === review.model)))
    return "The recommended model is not in this provider's available catalog.";
  if (review.action === "switch" && !review.nextStep) return "A model switch needs a concrete next step.";
  if (review.action === "switch" && review.model === current.model && review.effort === current.effort) return "The recommended settings are already active.";
  return null;
}

export function modelRoutingInstructions(choice: Choice, models: ModelOption[], switches: number): string {
  return `<model-routing>\nYour FIRST action, before tools or implementation, is to review the owner's task and the current step's complexity. Recommend the least expensive capable model and lowest sufficient reasoning effort; do not assume a change is always beneficial. Simple localized edits usually warrant low effort; uncertain debugging or cross-system design may warrant more. Reassess at phase boundaries and step down after difficult work. Avoid switching for negligible benefit because handoffs also cost tokens.\nCurrent provider: ${choice.provider}; model: ${choice.model ?? "CLI default (unknown model)"}; effort: ${choice.effort}. Candidate models: ${JSON.stringify(models)}. Supported efforts: ${PROVIDER_EFFORTS[choice.provider].join(", ")}. Catalog order is not a price ranking. Do not invent availability or exact costs; retain the current model when unsure.\nBegin with a brief recommendation and a fenced model-review JSON block: {"complexity":"simple|moderate|complex","model":"exact candidate id or current id (null only if current is CLI default)","effort":"supported effort","reason":"why these settings fit this step","action":"continue|switch","nextStep":"required for switch"}. Use action continue when retaining current settings, then do the work.\nIf a change is worthwhile, use action switch, emit a complete context-handoff block, and END THE TURN immediately without starting the next step or delegating. The dashboard validates the choice and starts a fresh session with the handoff, original owner request and nextStep. You cannot change your running model in place. Switch only within the current provider. At most 3 automatic switches per owner message; ${switches} have already occurred. Never switch once the task is complete. Handoff preparation runs do not use this protocol.\n</model-routing>`;
}
