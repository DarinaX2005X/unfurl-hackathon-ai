import "server-only";

/** Fixed SQL aliases only. Every caller also requires a ready version and passed receipt. */
export function readySourceSql(version: string, run: string, receipt: string): string {
  if (![version, run, receipt].every((alias) => /^[a-z_]+$/.test(alias))) throw new Error("Invalid readiness alias");
  return `(
    (${version}.release_metadata IS NULL AND ${run}.status = 'succeeded' AND ${run}.output_version_id = ${version}.id)
    OR (${version}.release_metadata->>'kind'='official-section-preview-v1'
      AND ${version}.release_metadata->>'publisher'='Unfurl'
      AND ${run}.status IN ('failed','cancelled') AND ${run}.output_version_id IS NULL
      AND ${run}.approval_id=${version}.approval_id
      AND ${version}.release_metadata->>'sourceRunId'=${run}.id::text
      AND ${version}.release_metadata->>'courseVersionId'=${version}.id::text
      AND ${version}.release_metadata->>'approvalId'=${version}.approval_id::text
      AND ${version}.release_metadata->>'approvalDigest'=${version}.content_digest
      AND ${receipt}.document->>'validatorVersion'='official-section-preview-v1'
      AND ${receipt}.document->>'sourceRunId'=${run}.id::text
      AND ${receipt}.document->>'approvalDigest'=${version}.content_digest
      AND ${receipt}.document->>'completedStepId'=${version}.release_metadata->>'completedStepId'
      AND ${receipt}.document->>'contentDigest'=${version}.release_metadata->>'releaseDigest')
    OR (${version}.release_metadata->>'kind'='official-editorial-section-v1'
      AND ${version}.release_metadata->>'publisher'='Unfurl'
      AND ${run}.status IN ('failed','cancelled') AND ${run}.output_version_id IS NULL
      AND ${run}.approval_id=${version}.approval_id
      AND ${version}.release_metadata->>'sourceRunId'=${run}.id::text
      AND ${version}.release_metadata->>'courseVersionId'=${version}.id::text
      AND ${version}.release_metadata->>'approvalId'=${version}.approval_id::text
      AND ${version}.release_metadata->>'approvalDigest'=${version}.content_digest
      AND ${receipt}.document->>'validatorVersion'='official-editorial-section-v1'
      AND ${receipt}.document->>'sourceRunId'=${run}.id::text
      AND ${receipt}.document->>'approvalDigest'=${version}.content_digest
      AND ${receipt}.document->>'editorialContentDigest'=${version}.release_metadata->>'editorialContentDigest'
      AND ${receipt}.document->>'contentDigest'=${version}.release_metadata->>'releaseDigest')
  )`;
}
