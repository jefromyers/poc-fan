import {
  getCompareResults,
  getCompareStatus,
  listCompareJobs,
  submitCompareJob,
} from "@/lib/compare-jobs";
import {
  compareRunsForPull,
  getRunResult,
  listRunsForPull,
} from "@/lib/mcp-pull";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_NAME = "thinking-inspector";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  status = 200,
) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function unauthorized() {
  return json({ error: "unauthorized" }, { status: 401 });
}

function isAuthorized(req: Request) {
  const token = process.env.MCP_API_TOKEN ?? process.env.MCP_AUTH_TOKEN ?? "";
  if (!token) return false;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

function originAllowed(req: Request) {
  const origin = req.headers.get("origin");
  const allowed = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return !origin || allowed.length === 0 || allowed.includes(origin);
}

const toolDefinitions = [
  {
    name: "run_compare",
    description: "Submit a prompt batch to Thinking Inspector and start async compare runs.",
    inputSchema: {
      type: "object",
      properties: {
        prompts: {
          type: "array",
          items: { type: "string" },
          description: "Prompt batch to run and compare.",
        },
        runs: {
          type: "integer",
          minimum: 1,
          default: 6,
          description: "Number of repeated runs per prompt.",
        },
        model: { type: "string", description: "OpenAI model ID." },
        effort: {
          type: "string",
          enum: ["none", "low", "medium", "high", "xhigh"],
          default: "medium",
        },
        profile: { type: "string", default: "latest" },
        label: { type: "string" },
      },
      required: ["prompts", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "get_compare_status",
    description: "Get status for a Thinking Inspector compare job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_compare_results",
    description:
      "Fetch structured compare results, including per-run answer output text when outputs are requested.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        include: {
          type: "array",
          items: {
            type: "string",
            enum: ["summary", "outputs", "query_fanout", "read_urls", "overlap"],
          },
        },
        read_urls_limit: { type: "integer", minimum: 1, maximum: 1000 },
        read_urls_offset: { type: "integer", minimum: 0 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_compare_jobs",
    description: "List recent Thinking Inspector compare jobs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_runs",
    description:
      "List/search recent Thinking Inspector runs so a user can choose existing outputs or runs to compare.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        before: { type: "string", description: "ISO timestamp cursor from a prior list_runs call." },
        search: { type: "string", description: "Case-insensitive search over prompt text." },
        status: {
          type: "string",
          enum: ["running", "completed", "incomplete", "failed", "cancelled"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run_result",
    description:
      "Pull one existing Thinking Inspector run into context with its prompt, output text, counts, and sources.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        include_reasoning: { type: "boolean", default: false },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_runs",
    description:
      "Deep-compare existing Thinking Inspector run IDs and pull outputs, read URLs, and overlap into context.",
    inputSchema: {
      type: "object",
      properties: {
        run_ids: {
          type: "array",
          items: { type: "string" },
          description: "Stored run IDs to compare, in the role order the user wants.",
        },
        include: {
          type: "array",
          items: {
            type: "string",
            enum: ["summary", "outputs", "query_fanout", "read_urls", "overlap"],
          },
        },
        read_urls_limit: { type: "integer", minimum: 1, maximum: 1000 },
        read_urls_offset: { type: "integer", minimum: 0 },
      },
      required: ["run_ids"],
      additionalProperties: false,
    },
  },
];

function toolResult(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

async function callTool(name: string, args: any) {
  switch (name) {
    case "run_compare":
      return submitCompareJob(args ?? {});
    case "get_compare_status":
      return getCompareStatus(String(args?.job_id ?? ""));
    case "get_compare_results":
      return getCompareResults(args ?? {});
    case "list_compare_jobs":
      return listCompareJobs(args?.limit ?? 20);
    case "list_runs":
      return listRunsForPull(args ?? {});
    case "get_run_result":
      return getRunResult(args ?? {});
    case "compare_runs":
      return compareRunsForPull(args ?? {});
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function GET() {
  return json({ error: "GET is not supported; send JSON-RPC over POST" }, { status: 405 });
}

export async function POST(req: Request) {
  if (!originAllowed(req)) return json({ error: "origin not allowed" }, { status: 403 });
  if (!isAuthorized(req)) return unauthorized();

  const body = (await req.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(null, -32600, "invalid JSON-RPC request", 400);
  }

  if (body.method.startsWith("notifications/") && (body.id === undefined || body.id === null)) {
    return new Response(null, { status: 202 });
  }

  if (body.method === "initialize") {
    return rpcResult(body.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
  }

  if (body.method === "tools/list") {
    return rpcResult(body.id, { tools: toolDefinitions });
  }

  if (body.method === "tools/call") {
    const name = body.params?.name;
    if (typeof name !== "string") {
      return rpcError(body.id, -32602, "tools/call requires params.name");
    }
    try {
      const result = await callTool(name, body.params?.arguments ?? {});
      return rpcResult(body.id, toolResult(result));
    } catch (e: any) {
      return rpcResult(body.id, {
        content: [{ type: "text", text: e?.message ?? String(e) }],
        isError: true,
      });
    }
  }

  return rpcError(body.id, -32601, `method not found: ${body.method}`);
}
