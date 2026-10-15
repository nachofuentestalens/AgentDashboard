import { useQuery } from "@tanstack/react-query";
import { MODEL_PRESETS } from "@ad/shared";
import { api } from "./api.ts";

export function useModelCatalog() {
  const query = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: Infinity });
  return { presets: query.data?.presets ?? MODEL_PRESETS, status: query.data?.codex, error: query.error };
}
