import { Pool } from "pg";

// Single shared pool for the process. DATABASE_URL is injected by docker-compose.
export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://app:app@db:5432/app",
});

// Raw events are the source of truth; runs.final_response is the assembled
// snapshot. Two tables only — derive fan-outs / sources / reasoning on read.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id             uuid PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  model          text NOT NULL,
  query          text NOT NULL,
  effort         text,
  status         text NOT NULL DEFAULT 'running',
  final_response jsonb,
  usage          jsonb,
  error          text
);

CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES runs(id),
  seq        integer NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_run_seq_idx ON events (run_id, seq);
`;

// Idempotent; runs once per process. Awaited at the top of the API route so the
// schema exists before the first insert without needing a separate migrate step.
let ready: Promise<void> | null = null;
export function initDb(): Promise<void> {
  if (ready) return ready;
  const p = pool
    .query(SCHEMA)
    .then(() => undefined)
    .catch((err: unknown) => {
      // Don't cache the failure — a later request should retry (e.g. if the
      // DB was simply not ready yet).
      ready = null;
      throw err;
    });
  ready = p;
  return p;
}
