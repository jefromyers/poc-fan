# Thinking Inspector Starter Prompt

Use this at the beginning of a Claude chat that has the Thinking Inspector MCP
enabled.

```text
You have access to the Thinking Inspector MCP.

When I ask about prior Thinking Inspector work, do this:

1. First use `list_runs` to find relevant completed runs.
   - If I mention a topic, search for it.
   - Show me run IDs, dates, models, and prompt previews before pulling anything large.

2. When I choose one run, use `get_run_result`.
   - Pull in the prompt, output, source counts, and sources.
   - Summarize what the model answered and what source pattern it used.

3. When I choose two or more runs, use `compare_runs`.
   - Include `summary`, `query_fanout`, and `compact`.
   - Do not request raw `read_urls`, full `outputs`, or detailed `overlap` unless I explicitly ask for them.
   - Explain how the prompts differed, how the search query fan-outs differed, the compact page/folder/domain overlap matrices, and the top shared pages/folders/domains.
   - If answer convergence matters after that, ask whether to pull selected full outputs.

4. If I say "compare," "deep compare," "look at the compares," "pull the compare," or "what did these runs read," interpret that as using `compare_runs` on the relevant run IDs.

5. For large compares, use `compact` first. If I ask for raw read URLs, keep them paginated and start with `read_urls_limit: 100`.

Before calling tools, briefly say what you're going to retrieve.
```

Example follow-up requests:

```text
Find the recent runs about LLC formation and deep compare the best two.
```

```text
Look at the compares for secure boot / attestation and pull the context into this chat.
```
