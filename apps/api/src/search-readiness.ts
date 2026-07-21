import type { HealthDependency, PostgresClient } from "@alphanet/database";

const SEARCH_INDEX_MODEL = "amazon.titan-embed-text-v2:0:512";

interface ReadyRow {
  ready: boolean;
}

/**
 * API readiness must cover the configured semantic model as well as table
 * presence. Otherwise a task can accept traffic while querying a different
 * vector generation than the Worker writes.
 */
export function createSearchIndexContractDependency(
  sql: PostgresClient,
  configuredModel: string,
): HealthDependency {
  return {
    critical: true,
    name: "content-search-index-contract",
    async check(): Promise<void> {
      const rows = await sql<ReadyRow[]>`
        select
          ${configuredModel} = ${SEARCH_INDEX_MODEL}
          and to_regclass('platform.content_items_current_revision_idx') is not null
          and to_regclass(
            'system.content_embedding_jobs_revision_incomplete_idx'
          ) is not null
          and to_regclass('platform.agent_search_activity_events_started_idx')
            is not null
          and (
            select count(*) = 2
            from pg_catalog.pg_constraint as model_constraint
            where model_constraint.conrelid in (
                'platform.content_embedding_chunks'::regclass,
                'system.content_embedding_jobs'::regclass
              )
              and model_constraint.conname in (
                'content_embedding_chunks_model',
                'content_embedding_jobs_model'
              )
              and model_constraint.convalidated
              and position(
                ${SEARCH_INDEX_MODEL}
                in pg_catalog.pg_get_constraintdef(model_constraint.oid)
              ) > 0
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger as revision_trigger
            where revision_trigger.tgrelid =
                'platform.content_revisions'::regclass
              and revision_trigger.tgname =
                'content_revisions_enqueue_embedding_job'
              and not revision_trigger.tgisinternal
              and revision_trigger.tgenabled in ('O', 'A')
              and revision_trigger.tgfoid = to_regprocedure(
                'system.enqueue_content_embedding_job_from_revision()'
              )
          ) as ready
      `;
      if (rows[0]?.ready !== true) {
        throw new Error("The Content Search index contract is not ready.");
      }
    },
    close: () => Promise.resolve(),
  };
}
