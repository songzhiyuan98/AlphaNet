import { randomUUID } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

export interface OwnerAccountExportContext {
  authenticatedAt: Date;
  authenticationAssurance: "fresh_owner_session";
  requestId: string;
}

export interface OwnerAccountExportService {
  checkReady(): Promise<void>;
  exportAccountData(
    ownerId: string,
    context: OwnerAccountExportContext,
  ): Promise<unknown>;
}

export class OwnerAccountExportError extends Error {
  readonly code = "OWNER_ACCOUNT_EXPORT_UNAVAILABLE";
  readonly retryable = true;
  readonly statusCode = 503;

  constructor() {
    super("Owner account data export is temporarily unavailable.");
    this.name = "OwnerAccountExportError";
  }
}

type TransactionSql = postgres.TransactionSql<Record<string, postgres.PostgresType>>;

interface SnapshotRow {
  snapshot: unknown;
}

function unavailable(): OwnerAccountExportError {
  return new OwnerAccountExportError();
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export class PostgresOwnerAccountExportService implements OwnerAccountExportService {
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(
    sql: PostgresClient,
    options: { idFactory?: (() => string) | undefined } = {},
  ) {
    this.#sql = sql;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql<{ ready: boolean }[]>`
      select
        to_regclass('platform.owners') is not null
        and to_regclass('platform.actors') is not null
        and to_regclass('platform.agents') is not null
        and to_regclass('platform.agent_policies') is not null
        and to_regclass('platform.credentials') is not null
        and to_regclass('platform.content_items') is not null
        and to_regclass('platform.content_revisions') is not null
        and to_regclass('platform.content_additional_communities') is not null
        and to_regclass('platform.content_symbols') is not null
        and to_regclass('platform.content_topics') is not null
        and to_regclass('platform.source_links') is not null
        and to_regclass('platform.content_relations') is not null
        and to_regclass('platform.mentions') is not null
        and to_regclass('platform.reactions') is not null
        and to_regclass('platform.follows') is not null
        and to_regclass('platform.notifications') is not null
        and to_regclass('platform.reports') is not null
        and to_regclass('platform.action_logs') is not null
          as ready
    `;
    if (rows[0]?.ready !== true) throw unavailable();
  }

  async exportAccountData(
    ownerId: string,
    context: OwnerAccountExportContext,
  ): Promise<unknown> {
    if (
      !validUuid(ownerId) ||
      context.requestId.trim().length === 0 ||
      context.requestId.length > 200 ||
      context.authenticationAssurance !== "fresh_owner_session" ||
      !Number.isFinite(context.authenticatedAt.valueOf())
    ) {
      throw unavailable();
    }
    const auditId = this.#idFactory();
    if (!validUuid(auditId)) throw unavailable();

    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          const rows = await transaction<SnapshotRow[]>`
            select jsonb_build_object(
              'export_version', 'owner-account-data-v1',
              'generated_at', clock_timestamp(),
              'owner', jsonb_build_object(
                'id', owner.id::text,
                'email', owner.email::text,
                'email_verified_at', owner.email_verified_at,
                'status', owner.status,
                'restriction_reason_code', owner.restriction_reason_code,
                'restricted_at', owner.restricted_at,
                'suspended_at', owner.suspended_at,
                'locale', owner.locale,
                'timezone', owner.timezone,
                'base_active_agent_limit', owner.base_active_agent_limit,
                'created_at', owner.created_at,
                'updated_at', owner.updated_at,
                'deleted_at', owner.deleted_at
              ),
              'human_profile', (
                select jsonb_build_object(
                  'id', actor.id::text,
                  'kind', actor.kind,
                  'handle', actor.handle::text,
                  'display_name', actor.display_name,
                  'bio', actor.bio,
                  'status', actor.status,
                  'created_at', actor.created_at,
                  'updated_at', actor.updated_at,
                  'deleted_at', actor.deleted_at
                )
                from platform.actors as actor
                where actor.owner_id = owner.id
                  and actor.kind = 'human'
                limit 1
              ),
              'agents', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', agent.id::text,
                    'actor', jsonb_build_object(
                      'id', actor.id::text,
                      'kind', actor.kind,
                      'handle', actor.handle::text,
                      'display_name', actor.display_name,
                      'bio', actor.bio,
                      'status', actor.status,
                      'created_at', actor.created_at,
                      'updated_at', actor.updated_at,
                      'deleted_at', actor.deleted_at
                    ),
                    'discovery_tags', to_jsonb(agent.discovery_tags),
                    'status', agent.status,
                    'restriction_reason_code', agent.restriction_reason_code,
                    'restricted_at', agent.restricted_at,
                    'suspended_at', agent.suspended_at,
                    'created_at', agent.created_at,
                    'updated_at', agent.updated_at,
                    'activated_at', agent.activated_at,
                    'archived_at', agent.archived_at,
                    'deleted_at', agent.deleted_at,
                    'policies', coalesce((
                      select jsonb_agg(
                        jsonb_build_object(
                          'id', policy.id::text,
                          'tier', policy.tier,
                          'defaults_version', policy.defaults_version,
                          'policy_schema_version', policy.policy_schema_version,
                          'version', policy.version::text,
                          'rules', policy.rules,
                          'effective_from', policy.effective_from,
                          'is_active', policy.is_active,
                          'created_at', policy.created_at
                        )
                        order by policy.version
                      )
                      from platform.agent_policies as policy
                      where policy.agent_id = agent.id
                    ), '[]'::jsonb),
                    'credentials', coalesce((
                      select jsonb_agg(
                        jsonb_build_object(
                          'id', credential.id::text,
                          'name', credential.name,
                          'credential_type', credential.credential_type,
                          'token_prefix', credential.token_prefix,
                          'scopes', to_jsonb(credential.scopes),
                          'audience', credential.audience,
                          'policy_ceiling', credential.policy_ceiling,
                          'issued_at', credential.issued_at,
                          'expires_at', credential.expires_at,
                          'last_used_at', credential.last_used_at,
                          'revoked_at', credential.revoked_at,
                          'replaces_credential_id',
                            credential.replaces_credential_id::text
                        )
                        order by credential.issued_at, credential.id
                      )
                      from platform.credentials as credential
                      where credential.owner_id = owner.id
                        and credential.agent_id = agent.id
                    ), '[]'::jsonb)
                  )
                  order by agent.created_at, agent.id
                )
                from platform.agents as agent
                join platform.actors as actor
                  on actor.id = agent.actor_id
                 and actor.owner_id = owner.id
                where agent.owner_id = owner.id
              ), '[]'::jsonb),
              'content', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', content.id::text,
                    'version', content.version::text,
                    'kind', content.kind,
                    'author_actor_id', content.author_actor_id::text,
                    'primary_community_id', content.primary_community_id::text,
                    'additional_community_ids', coalesce((
                      select jsonb_agg(placement.community_id::text order by placement.position)
                      from platform.content_additional_communities as placement
                      where placement.content_id = content.id
                    ), '[]'::jsonb),
                    'symbol_ids', coalesce((
                      select jsonb_agg(symbol.symbol_id::text order by symbol.position)
                      from platform.content_symbols as symbol
                      where symbol.content_id = content.id
                    ), '[]'::jsonb),
                    'topic_ids', coalesce((
                      select jsonb_agg(topic.topic_id::text order by topic.position)
                      from platform.content_topics as topic
                      where topic.content_id = content.id
                    ), '[]'::jsonb),
                    'root_id', content.root_id::text,
                    'parent_id', content.parent_id::text,
                    'depth', content.depth,
                    'current_revision_id', content.current_revision_id::text,
                    'lifecycle_state', content.lifecycle_state,
                    'distribution_state', content.distribution_state,
                    'erasure_state', content.erasure_state,
                    'published_at', content.published_at,
                    'created_at', content.created_at,
                    'updated_at', content.updated_at,
                    'deleted_at', content.deleted_at,
                    'revisions', coalesce((
                      select jsonb_agg(
                        jsonb_build_object(
                          'id', revision.id::text,
                          'revision_number', revision.revision_number::text,
                          'title', revision.title,
                          'body_markdown', revision.body_markdown,
                          'body_plain_text', revision.body_plain_text,
                          'edit_summary', revision.edit_summary,
                          'created_by_actor_id', revision.created_by_actor_id::text,
                          'created_at', revision.created_at,
                          'source_version', revision.source_version::text
                        )
                        order by revision.revision_number
                      )
                      from platform.content_revisions as revision
                      where revision.content_id = content.id
                    ), '[]'::jsonb),
                    'source_links', coalesce((
                      select jsonb_agg(
                        jsonb_build_object(
                          'id', source.id::text,
                          'position', source.position,
                          'url', source.url,
                          'title', source.title,
                          'description', source.description,
                          'added_revision_id', source.added_revision_id::text,
                          'added_by_actor_id', source.added_by_actor_id::text,
                          'added_at', source.added_at,
                          'removed_revision_id', source.removed_revision_id::text
                        )
                        order by source.added_at, source.id
                      )
                      from platform.source_links as source
                      where source.content_id = content.id
                    ), '[]'::jsonb),
                    'relations', coalesce((
                      select jsonb_agg(
                        jsonb_build_object(
                          'id', relation.id::text,
                          'to_content_id', relation.to_content_id::text,
                          'position', relation.position,
                          'relation_type', relation.relation_type,
                          'added_revision_id', relation.added_revision_id::text,
                          'removed_revision_id', relation.removed_revision_id::text,
                          'created_at', relation.created_at
                        )
                        order by relation.created_at, relation.id
                      )
                      from platform.content_relations as relation
                      where relation.from_content_id = content.id
                    ), '[]'::jsonb),
                    'mentions', coalesce((
                      select jsonb_agg(
                        jsonb_build_object(
                          'revision_id', mention.revision_id::text,
                          'revision_number', mention.revision_number::text,
                          'mentioned_actor_id', mention.mentioned_actor_id::text,
                          'position', mention.position,
                          'created_at', mention.created_at
                        )
                        order by mention.revision_number, mention.position
                      )
                      from platform.mentions as mention
                      where mention.content_id = content.id
                    ), '[]'::jsonb)
                  )
                  order by content.created_at, content.id
                )
                from platform.content_items as content
                join platform.actors as author
                  on author.id = content.author_actor_id
                 and author.owner_id = owner.id
              ), '[]'::jsonb),
              'interactions', jsonb_build_object(
                'reactions', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'actor_id', reaction.actor_id::text,
                      'content_id', reaction.content_id::text,
                      'reaction_type', reaction.reaction_type,
                      'created_at', reaction.created_at
                    )
                    order by reaction.created_at, reaction.actor_id, reaction.content_id
                  )
                  from platform.reactions as reaction
                  join platform.actors as actor
                    on actor.id = reaction.actor_id
                   and actor.owner_id = owner.id
                ), '[]'::jsonb),
                'follows', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', follow.id::text,
                      'follower_actor_id', follow.follower_actor_id::text,
                      'target_type', follow.target_type,
                      'target_id', coalesce(
                        follow.target_actor_id,
                        follow.target_symbol_id,
                        follow.target_topic_id,
                        follow.target_content_id
                      )::text,
                      'notification_level', follow.notification_level,
                      'created_at', follow.created_at,
                      'updated_at', follow.updated_at
                    )
                    order by follow.created_at, follow.id
                  )
                  from platform.follows as follow
                  join platform.actors as actor
                    on actor.id = follow.follower_actor_id
                   and actor.owner_id = owner.id
                ), '[]'::jsonb),
                'notifications', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', notification.id::text,
                      'version', notification.version::text,
                      'recipient_actor_id', notification.recipient_actor_id::text,
                      'type', notification.type,
                      'trigger_actor_id', notification.trigger_actor_id::text,
                      'object_type', notification.object_type,
                      'object_id', notification.object_id::text,
                      'context', notification.context,
                      'occurred_at', notification.occurred_at,
                      'last_occurred_at', notification.last_occurred_at,
                      'created_at', notification.created_at,
                      'updated_at', notification.updated_at,
                      'read_at', notification.read_at
                    )
                    order by notification.created_at, notification.id
                  )
                  from platform.notifications as notification
                  join platform.actors as actor
                    on actor.id = notification.recipient_actor_id
                   and actor.owner_id = owner.id
                ), '[]'::jsonb),
                'reports', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', report.id::text,
                      'version', report.version::text,
                      'reporter_actor_id', report.reporter_actor_id::text,
                      'target_type', report.target_type,
                      'target_content_id', report.target_content_id::text,
                      'reason_code', report.reason_code,
                      'description', report.description,
                      'status', report.status,
                      'authentication_assurance', report.authentication_assurance,
                      'submitted_via', report.submitted_via,
                      'created_at', report.created_at,
                      'updated_at', report.updated_at,
                      'resolved_at', report.resolved_at
                    )
                    order by report.created_at, report.id
                  )
                  from platform.reports as report
                  where report.reporter_owner_id = owner.id
                ), '[]'::jsonb)
              )
            ) as snapshot
            from platform.owners as owner
            where owner.id = ${ownerId}
              and owner.status = 'active'
              and owner.email_verified_at is not null
              and owner.deleted_at is null
          `;
          const snapshot = rows[0]?.snapshot;
          if (snapshot === undefined || snapshot === null) throw unavailable();
          await this.#writeAudit(transaction, auditId, ownerId, context);
          return snapshot;
        },
      );
    } catch (error) {
      if (error instanceof OwnerAccountExportError) throw error;
      throw unavailable();
    }
  }

  async #writeAudit(
    transaction: TransactionSql,
    auditId: string,
    ownerId: string,
    context: OwnerAccountExportContext,
  ): Promise<void> {
    await transaction`
      insert into platform.action_logs (
        id,
        event_class,
        owner_id,
        channel,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        request_id
      )
      values (
        ${auditId},
        'sensitive_read',
        ${ownerId},
        'web',
        ${context.authenticationAssurance},
        ${transaction.json({
          resource: "owner_account_data_export",
          reauthenticated: true,
        })},
        'owner.account_data_export',
        'owner_account_data_export',
        ${ownerId},
        'allow',
        'succeeded',
        ${context.requestId}
      )
    `;
  }
}
