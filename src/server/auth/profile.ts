import "server-only";
import { ProfileSchema, type AccountSession, type Profile, type UpdateProfileInput } from "../../domain/account";
import type { Actor } from "./actor";
import type { VerifiedIdentity } from "./session";
import { ServiceFault, unavailable } from "./errors";
import { withActorTransaction, type DbTransaction } from "../db";
import { executeIdempotent } from "../idempotency";

interface ProfileRow {
  id: string;
  display_name: string | null;
  default_content_language: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function profileFromRow(row: ProfileRow): Profile {
  return ProfileSchema.parse({
    id: row.id, displayName: row.display_name, defaultContentLanguage: row.default_content_language,
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  });
}

async function loadOrCreate(tx: DbTransaction, actor: Actor, initialDisplayName: string | null): Promise<Profile> {
  await tx.query(
    "INSERT INTO unfurl.profiles (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [actor.id, initialDisplayName],
  );
  const result = await tx.query<ProfileRow>(
    "SELECT id, display_name, default_content_language, revision, created_at, updated_at FROM unfurl.profiles WHERE id = $1",
    [actor.id],
  );
  if (!result.rows[0]) throw unavailable("storage.unavailable");
  return profileFromRow(result.rows[0]);
}

export async function accountSession(verified: VerifiedIdentity): Promise<AccountSession> {
  const profile = await withActorTransaction(verified.actor, (tx) => loadOrCreate(tx, verified.actor, verified.initialDisplayName));
  return { identity: verified.identity, profile };
}

export async function updateProfile(actor: Actor, input: UpdateProfileInput, key: string): Promise<Profile> {
  const receipt = await executeIdempotent(actor, { operation: "profile.update", key, body: input, parseResult: ProfileSchema }, async (tx) => {
    const updated = await tx.query<ProfileRow>(
      `UPDATE unfurl.profiles
       SET display_name = CASE WHEN $3 THEN $4 ELSE display_name END,
           default_content_language = CASE WHEN $5 THEN $6 ELSE default_content_language END,
           revision = revision + 1, updated_at = now()
       WHERE id = $1 AND revision = $2
       RETURNING id, display_name, default_content_language, revision, created_at, updated_at`,
      [actor.id, input.expectedRevision, input.displayName !== undefined, input.displayName ?? null,
        input.defaultContentLanguage !== undefined, input.defaultContentLanguage ?? null],
    );
    if (!updated.rows[0]) {
      const current = await tx.query<{ revision: number }>("SELECT revision FROM unfurl.profiles WHERE id = $1", [actor.id]);
      const revision = current.rows[0]?.revision;
      if (revision === undefined) throw new ServiceFault(404, "not_found", "account.profileNotFound");
      throw new ServiceFault(409, "revision_conflict", "account.profileConflict", false, { currentRevision: revision });
    }
    return { status: 200, data: profileFromRow(updated.rows[0]) };
  });
  return receipt.data;
}
