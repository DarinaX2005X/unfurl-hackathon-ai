import { Client } from "pg";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { visibleResearchStepsCte } from "../../src/server/agent-turns/research-visibility";
import { captureContext } from "../../src/server/agent-turns/repository";
import type { DbTransaction } from "../../src/server/db";
import { IdSchema } from "../../src/domain/common";
import { ConversationSchema } from "../../src/domain/generation";
import { readActionHistory } from "../../src/server/conversations/repository";
import type { Actor } from "../../src/server/auth/actor";

const uuid = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const earlier = "2026-01-01T10:00:00Z", accepted = "2026-01-01T11:00:00Z", later = "2026-01-01T12:00:00Z";

it.skipIf(process.env.RUN_READONLY_RESEARCH !== "1")("proves SQL visibility boundaries without writes and projects the authorized continuation", async () => {
  const currentJob = IdSchema.parse(process.env.RESEARCH_VISIBILITY_JOB_ID);
  const url = new URL(process.env.DIRECT_DATABASE_URL!);
  for (const option of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(option);
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) } });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE service_role");
    const fixtures = {
      conversations: [{ id: uuid(1), owner_id: uuid(2), active_branch_id: uuid(3), deleted_at: null },
        { id: uuid(10), owner_id: uuid(20), active_branch_id: uuid(30), deleted_at: null }],
      messages: [
        { id: uuid(4), conversation_id: uuid(1), branch_id: uuid(3), role: "user", status: "complete", created_at: accepted },
        { id: uuid(5), conversation_id: uuid(1), branch_id: uuid(3), role: "user", status: "complete", created_at: earlier },
        { id: uuid(6), conversation_id: uuid(1), branch_id: uuid(3), role: "user", status: "complete", created_at: later },
        { id: uuid(7), conversation_id: uuid(1), branch_id: uuid(33), role: "user", status: "complete", created_at: earlier },
        { id: uuid(8), conversation_id: uuid(10), branch_id: uuid(30), role: "user", status: "complete", created_at: earlier },
      ],
      runs: [
        { id: uuid(40), owner_id: uuid(2), conversation_id: uuid(1), branch_id: uuid(3), input_message_id: uuid(4), created_at: accepted },
        { id: uuid(50), owner_id: uuid(2), conversation_id: uuid(1), branch_id: uuid(3), input_message_id: uuid(5), created_at: earlier },
        { id: uuid(60), owner_id: uuid(2), conversation_id: uuid(1), branch_id: uuid(3), input_message_id: uuid(6), created_at: later },
        { id: uuid(70), owner_id: uuid(2), conversation_id: uuid(1), branch_id: uuid(33), input_message_id: uuid(7), created_at: earlier },
        { id: uuid(80), owner_id: uuid(20), conversation_id: uuid(10), branch_id: uuid(30), input_message_id: uuid(8), created_at: earlier },
      ],
      jobs: [40, 50, 60, 70, 80].map((value) => ({ id: uuid(value + 1), agent_turn_run_id: uuid(value) })),
      steps: [40, 50, 60, 70, 80].map((value) => ({ id: uuid(value + 2), job_id: uuid(value + 1), status: "succeeded",
        step_key: "agent.v1:000000:tool", updated_at: value === 40 || value === 60 ? later : earlier })),
    };
    fixtures.steps.push({ id: uuid(99), job_id: uuid(51), status: "succeeded", step_key: "agent.v1:000001:tool", updated_at: later });
    const fixtureCtes = `WITH fixture_conversations AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'conversations') AS t(id uuid,owner_id uuid,active_branch_id uuid,deleted_at timestamptz)),
      fixture_messages AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'messages') AS t(id uuid,conversation_id uuid,branch_id uuid,role text,status text,created_at timestamptz)),
      fixture_runs AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'runs') AS t(id uuid,owner_id uuid,conversation_id uuid,branch_id uuid,input_message_id uuid,created_at timestamptz)),
      fixture_jobs AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'jobs') AS t(id uuid,agent_turn_run_id uuid)),
      fixture_steps AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'steps') AS t(id uuid,job_id uuid,status text,step_key text,updated_at timestamptz)),`;
    const fixtureScope = visibleResearchStepsCte.replace(/^WITH /, "")
      .replaceAll("unfurl.conversations", "fixture_conversations").replaceAll("unfurl.messages", "fixture_messages")
      .replaceAll("unfurl.agent_turn_runs", "fixture_runs").replaceAll("unfurl.execution_jobs", "fixture_jobs").replaceAll("unfurl.run_steps", "fixture_steps");
    const scopedQuery = `${fixtureCtes}${fixtureScope} SELECT id FROM visible_research_steps ORDER BY id`;
    expect((await client.query(scopedQuery, [uuid(41), JSON.stringify(fixtures)])).rows.map((row) => row.id)).toEqual([uuid(42), uuid(52)]);
    const deleted = structuredClone(fixtures);
    Object.assign(deleted.conversations[0]!, { deleted_at: accepted });
    expect((await client.query(scopedQuery, [uuid(41), JSON.stringify(deleted)])).rows).toEqual([]);
    const switched = structuredClone(fixtures);
    switched.conversations[0]!.active_branch_id = uuid(33);
    expect((await client.query(scopedQuery, [uuid(41), JSON.stringify(switched)])).rows).toEqual([]);

    const row = (await client.query(`SELECT r.id,r.owner_id,r.conversation_id,r.branch_id,r.input_message_id FROM unfurl.execution_jobs j
      JOIN unfurl.agent_turn_runs r ON r.id=j.agent_turn_run_id WHERE j.id=$1`, [currentJob])).rows[0];
    expect(row).toBeDefined();
    const snapshot = await captureContext(client as unknown as DbTransaction, { kind: "agent_turn", runId: row.id, ownerId: row.owner_id,
      conversationId: row.conversation_id, branchId: row.branch_id, inputMessageId: row.input_message_id }, currentJob, 1, new Date().toISOString());
    expect(snapshot.searchMemory?.searches.length).toBe(4);
    expect(snapshot.sources.length).toBe(2);
    expect(snapshot.sourceMemory?.sources.reduce((count, source) => count + source.fullyReadBlockCount, 0)).toBe(16);
    const savedConversation = (await client.query("SELECT * FROM unfurl.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", [row.conversation_id, row.owner_id])).rows[0];
    const conversation = ConversationSchema.parse({ id: savedConversation.id, ownerId: savedConversation.owner_id, title: savedConversation.title,
      activeBranchId: savedConversation.active_branch_id, revision: savedConversation.revision,
      createdAt: savedConversation.created_at.toISOString(), updatedAt: savedConversation.updated_at.toISOString() });
    const actionPage = await readActionHistory(client as unknown as DbTransaction, { id: row.owner_id } as Actor, conversation, { limit: 5 });
    expect(actionPage.items.filter((event) => event.type === "action.started").length).toBe(5);
    expect(actionPage.nextCursor).not.toBeNull();
    console.log(JSON.stringify({ readonly: true, inheritedSearches: snapshot.searchMemory?.searches.length, inheritedSources: snapshot.sources.length,
      fullyReadBlocks: snapshot.sourceMemory?.sources.reduce((count, source) => count + source.fullyReadBlockCount, 0), visibilityNegativeCases: 5,
      retainedActionInvocations: actionPage.items.filter((event) => event.type === "action.started").length }));
  } finally { await client.query("ROLLBACK"); await client.end(); }
}, 60000);
