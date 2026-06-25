Tested via hum pr on 2026-05-23.

## MCP access

The app exposes an HTTP MCP endpoint at `/api/mcp`. It is protected by a shared
bearer token from `MCP_API_TOKEN` and is designed to be reached through
`mcp-remote`:

```json
{
  "mcpServers": {
    "thinking-inspector": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://YOUR_HOST/api/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_API_TOKEN"
      ]
    }
  }
}
```

Required environment:

- `OPENAI_API_KEY`
- `DATABASE_URL`
- `MCP_API_TOKEN`

Optional limits:

- `MCP_MAX_PROMPTS` defaults to `12`
- `MCP_MAX_TOTAL_RUNS` defaults to `72`
- `MCP_JOB_CONCURRENCY` defaults to `2`
- `MCP_RESULT_READ_URL_LIMIT` defaults to `500`
- `MCP_STALE_JOB_MINUTES` defaults to `720`

Tools exposed:

- `run_compare`
- `get_compare_status`
- `get_compare_results`
- `list_compare_jobs`
- `list_runs`
- `get_run_result`
- `compare_runs`

Useful Claude prompts:

```text
Use thinking-inspector to list recent completed runs. Show me the IDs, dates,
models, and prompt previews so I can choose which ones to pull in.
```

```text
Use thinking-inspector to search runs for "secure boot". Then compare the three
most relevant completed run IDs with summary, query fan-out, and compact
overlap. Do not request raw read URLs, full outputs, or detailed overlap unless
I ask for them.
```

```text
Use thinking-inspector to pull run <RUN_ID> into this chat, including its output
and sources.
```
