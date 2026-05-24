"use client";

import { memo, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-blue focus-visible:ring-offset-2";

// Close dangling markdown markers so the in-progress tail doesn't flip the
// rest of the document into bold/italic/code while tokens are still arriving.
function healMarkdown(input: string): string {
  if (!input) return input;
  let text = input;

  // Unterminated fenced code block: append a closing fence.
  const fenceMatches = text.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    text += text.endsWith("\n") ? "```" : "\n```";
    return text; // inside-fence content should not be further healed
  }

  // Unterminated link: `[label](http...` with no closing paren on the line.
  text = text.replace(/(\[[^\]\n]*\]\([^)\s\n]*)$/, "$1)");

  // Inline markers — count unescaped occurrences on the trailing segment.
  // We restrict to the last paragraph to avoid double-closing earlier balance.
  const lastBreak = text.lastIndexOf("\n\n");
  const head = lastBreak === -1 ? "" : text.slice(0, lastBreak);
  let tail = lastBreak === -1 ? text : text.slice(lastBreak);

  const pairs: Array<[RegExp, string]> = [
    [/(^|[^`])`(?!`)/g, "`"],
    [/\*\*/g, "**"],
    [/(^|[^*])\*(?!\*)/g, "*"],
    [/__/g, "__"],
    [/(^|[^_])_(?!_)/g, "_"],
  ];
  for (const [re, marker] of pairs) {
    const count = (tail.match(re) || []).length;
    if (count % 2 === 1) tail += marker;
  }

  return head + tail;
}

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1
      {...props}
      className="mt-2 text-2xl font-extrabold uppercase tracking-wider text-cl-blue"
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2
      {...props}
      className="mt-2 text-xl font-bold uppercase tracking-wider text-cl-blue"
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      {...props}
      className="mt-2 text-base font-bold uppercase tracking-wider text-cl-blue"
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 {...props} className="mt-2 text-sm font-bold uppercase tracking-wider text-cl-blue">
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p {...props} className="max-w-[72ch] text-base leading-relaxed text-cl-slate">
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul {...props} className="ml-1 list-disc space-y-1 pl-5 text-base leading-relaxed text-cl-slate">
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol {...props} className="ml-1 list-decimal space-y-1 pl-5 text-base leading-relaxed text-cl-slate">
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li {...props} className="max-w-[72ch]">
      {children}
    </li>
  ),
  a: ({ children, href, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`font-medium text-cl-blue hover:underline ${focusRing}`}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      {...props}
      className="border-l-4 border-cl-blue bg-cl-ice/60 px-4 py-2 text-cl-slate"
    >
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }: ComponentPropsWithoutRef<"code"> & { inline?: boolean }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code {...props} className={`${className ?? ""} font-mono text-[12px] leading-relaxed`}>
          {children}
        </code>
      );
    }
    return (
      <code
        {...props}
        className="rounded-[3px] bg-cl-ice px-1 py-0.5 font-mono text-[0.9em] text-cl-navy"
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      {...props}
      className="overflow-x-auto rounded-btn border border-cl-border bg-cl-bg-soft p-4 font-mono text-[12px] leading-relaxed text-cl-slate"
    >
      {children}
    </pre>
  ),
  hr: (props) => <hr {...props} className="border-cl-border" />,
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto rounded-card border border-cl-border">
      <table {...props} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead {...props} className="bg-cl-blue text-xs uppercase tracking-wider text-white">
      {children}
    </thead>
  ),
  th: ({ children, ...props }) => (
    <th {...props} className="px-3 py-2 text-left font-bold">
      {children}
    </th>
  ),
  tr: ({ children, ...props }) => (
    <tr {...props} className="even:bg-cl-ice/50">
      {children}
    </tr>
  ),
  td: ({ children, ...props }) => (
    <td {...props} className="px-3 py-2 align-top text-cl-slate">
      {children}
    </td>
  ),
  strong: ({ children, ...props }) => (
    <strong {...props} className="font-bold text-cl-slate">
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em {...props} className="italic">
      {children}
    </em>
  ),
};

type MarkdownProps = {
  text: string;
  streaming?: boolean;
  trailing?: ReactNode;
};

function MarkdownInner({ text, streaming, trailing }: MarkdownProps) {
  const healed = useMemo(() => (streaming ? healMarkdown(text) : text), [text, streaming]);
  return (
    <div className="max-w-[72ch] space-y-3">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {healed}
      </ReactMarkdown>
      {trailing}
    </div>
  );
}

export const Markdown = memo(MarkdownInner);
