// Pure serialization of a stored run into a Markdown document meant to be
// pasted into an LLM. No I/O here — the route reads the DB and hands us rows.

import {
  deriveRunState,
  describeAction,
  domain,
  normalizeUrl,
  type Source,
} from "@/lib/derive";
import type { StreamEvent } from "@/lib/events";

export type RunRow = {
  id: string;
  model: string;
  query: string;
  effort: string | null;
  status: string;
  created_at: string | Date;
  usage?: unknown;
  error?: string | null;
};

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type MarkdownExportOpts = { raw?: boolean };

// Escape a value for use inside a Markdown table cell: pipes break columns and
// newlines break rows, so neutralize both.
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isoDate(value: string | Date): string {
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function tokensLine(usage: unknown): string {
  const u = (usage ?? {}) as Usage;
  if (
    u.input_tokens == null &&
    u.output_tokens == null &&
    u.total_tokens == null
  ) {
    return "—";
  }
  const parts: string[] = [];
  if (u.input_tokens != null) parts.push(`input ${u.input_tokens}`);
  if (u.output_tokens != null) parts.push(`output ${u.output_tokens}`);
  if (u.total_tokens != null) parts.push(`total ${u.total_tokens}`);
  return parts.join(" · ");
}

function sourceLine(s: Source): string {
  const title = (s.title || s.url).replace(/[\[\]]/g, "");
  return `- [${title}](${s.url}) — ${domain(s.url)}`;
}

export function runToMarkdown(
  run: RunRow,
  events: StreamEvent[],
  opts: MarkdownExportOpts = {},
): string {
  const d = deriveRunState(events);
  const out: string[] = [];

  out.push("# Thinking Inspector Run");
  out.push("");
  out.push("| Field | Value |");
  out.push("| --- | --- |");
  out.push(`| Query | ${cell(run.query)} |`);
  out.push(`| Model | ${cell(run.model)} |`);
  out.push(`| Effort | ${cell(run.effort ?? "—")} |`);
  out.push(`| Status | ${cell(run.status)} |`);
  out.push(`| Created | ${cell(isoDate(run.created_at))} |`);
  out.push(`| Run ID | ${cell(run.id)} |`);
  out.push(`| Tokens | ${cell(tokensLine(run.usage))} |`);
  out.push("");

  if (run.error) {
    out.push("## Error");
    out.push("");
    out.push("```");
    out.push(run.error);
    out.push("```");
    out.push("");
  }

  out.push("## Reasoning Summary");
  out.push("");
  out.push(
    "> Note: this is the model's reasoning *summary*, not its raw " +
      "chain-of-thought (OpenAI does not expose the latter).",
  );
  out.push("");
  out.push(d.reasoning.trim() || "_No reasoning._");
  out.push("");

  out.push("## Answer");
  out.push("");
  // Emitted verbatim — answer is already a Markdown string.
  out.push(d.answer.trim() || "_No answer._");
  out.push("");

  // Sources split into cited (actually used) vs consulted-but-not-cited.
  const cited = d.sources.filter((s) => d.citedUrls.has(normalizeUrl(s.url)));
  const consultedOnly = d.sources.filter(
    (s) => !d.citedUrls.has(normalizeUrl(s.url)),
  );
  out.push("## Sources");
  out.push("");
  out.push(`### Cited (${cited.length})`);
  out.push("");
  out.push(cited.length ? cited.map(sourceLine).join("\n") : "_None._");
  out.push("");
  out.push(`### Consulted but not cited (${consultedOnly.length})`);
  out.push("");
  out.push(
    consultedOnly.length ? consultedOnly.map(sourceLine).join("\n") : "_None._",
  );
  out.push("");

  out.push(`## Actions (${d.fanouts.length})`);
  out.push("");
  if (d.fanouts.length === 0) {
    out.push("_No actions — the model may have answered from its own knowledge._");
  } else {
    out.push("| # | Action | Query / URL | Status |");
    out.push("| --- | --- | --- | --- |");
    d.fanouts.forEach((f, i) => {
      const a = describeAction(f.action);
      const detail =
        a.details && a.details.length > 0
          ? a.details.join("; ")
          : (a.detail ?? "");
      out.push(
        `| ${i + 1} | ${cell(a.label)} | ${cell(detail) || "—"} | ${cell(f.status)} |`,
      );
    });
  }
  out.push("");

  if (opts.raw) {
    out.push("## Raw Events");
    out.push("");
    out.push("```json");
    out.push(JSON.stringify(events, null, 2));
    out.push("```");
    out.push("");
  }

  return out.join("\n");
}

// Filename slug: query-derived, with a short id suffix for uniqueness.
export function exportFilename(run: RunRow): string {
  const slug =
    run.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "") || "run";
  return `${slug}-${run.id.slice(0, 8)}.md`;
}
