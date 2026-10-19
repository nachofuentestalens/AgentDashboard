import { z } from "zod";

export const companyConfigSchema = z
  .object({
    enabled: z.boolean(),
    description: z.string().trim().min(1).max(12000),
    genre: z.string().trim().min(1).max(200),
    references: z.string().trim().max(6000),
    audience: z.string().trim().max(2000),
    playtestInstructions: z.string().trim().max(6000),
    dailyHourUtc: z.number().int().min(0).max(23),
  })
  .strict();

export type CompanyConfig = z.infer<typeof companyConfigSchema>;
export type CompanyAssignmentKind = "director" | "qa";
export interface CompanyAssignment {
  day: string;
  kind: CompanyAssignmentKind;
  taskId: string | null;
  prompt: string;
  dispatched: boolean;
}
export interface CompanyView {
  config: CompanyConfig | null;
  assignments: (Omit<CompanyAssignment, "prompt"> & { status: string })[];
  error: string | null;
}
