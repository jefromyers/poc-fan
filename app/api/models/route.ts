import OpenAI from "openai";
import { DOCUMENTED_MODEL_FALLBACK, MODEL_CANDIDATES } from "@/lib/model-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 10 * 60 * 1000;
let cache: { expiresAt: number; models: string[] } | null = null;

export async function GET() {
  if (cache && cache.expiresAt > Date.now()) {
    return Response.json({ models: cache.models });
  }

  try {
    const client = new OpenAI();
    const models = await client.models.list();
    const available = new Set(models.data.map((m) => m.id));
    const selectable = MODEL_CANDIDATES.filter((id) => available.has(id));
    const result = selectable.length > 0 ? selectable : [...DOCUMENTED_MODEL_FALLBACK];
    cache = { expiresAt: Date.now() + CACHE_MS, models: result };
    return Response.json({ models: result });
  } catch {
    // If /v1/models is unavailable, expose only model IDs visible in the
    // current OpenAI Models docs rather than unverifiable legacy options.
    const result = [...DOCUMENTED_MODEL_FALLBACK];
    cache = { expiresAt: Date.now() + CACHE_MS, models: result };
    return Response.json({ models: result, fallback: true });
  }
}
