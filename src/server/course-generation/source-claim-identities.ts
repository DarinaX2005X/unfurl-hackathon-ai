import "server-only";
import type { z } from "zod";
import { IdSchema } from "@/domain/common";
import { ProviderFailure } from "@/server/ai/failure";
import { stableExecutionId } from "@/server/runs/identity";
import { ServerIdentitySourceClaimsProposalSchema, SourceClaimsProposalSchema } from "./checkpoints";

const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

/** The raw paid response stays immutable; each new identity belongs to its producer step. */
export function projectSourceClaimIdentities(raw: z.infer<typeof ServerIdentitySourceClaimsProposalSchema>, stepId: string): z.infer<typeof SourceClaimsProposalSchema> {
  IdSchema.parse(stepId);
  const proposal = ServerIdentitySourceClaimsProposalSchema.parse(raw);
  const identityMap = (labels: string[], kind: "passage" | "claim") => {
    if (new Set(labels).size !== labels.length) return invalid();
    const mapping = new Map(labels.map(label => [label, stableExecutionId(stepId, `source-${kind}:${label}`)]));
    if (new Set(mapping.values()).size !== mapping.size) return invalid();
    return mapping;
  };
  const passages = identityMap(proposal.passages.map(passage => passage.id), "passage");
  const claims = identityMap(proposal.claims.map(claim => claim.id), "claim");
  const passageId = (label: string) => passages.get(label) ?? invalid();
  const claimId = (label: string) => claims.get(label) ?? invalid();
  return SourceClaimsProposalSchema.parse({
    passages: proposal.passages.map(passage => ({ ...passage, id: passageId(passage.id) })),
    claims: proposal.claims.map(claim => ({ ...claim, id: claimId(claim.id), passageIds: claim.passageIds.map(passageId),
      unresolvedConflicts: claim.unresolvedConflicts.map(conflict => ({ ...conflict, otherClaimIds: conflict.otherClaimIds.map(claimId) })),
    })),
  });
}
