-- Better Auth core schema generated and reviewed from better-auth/auth CLI 1.6.23.
-- Golden source: packages/auth/schema/better-auth-1.6.23.sql
-- Raw generator output SHA-256 (before repository EOF-newline normalization):
-- faea89d0e9bf964339657d574ed9ee3d5e5255ee53286098333051d6e1db78aa
-- Do not run Better Auth's migrate command in production. All production schema
-- changes remain forward-only migrations owned by AlphaNet.

CREATE SCHEMA IF NOT EXISTS auth;

SET LOCAL search_path = auth, pg_catalog;

CREATE TABLE "users" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL,
  "image" text,
  "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "sessions" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "expires_at" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE TABLE "accounts" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE TABLE "verifications" (
  "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");

CREATE INDEX "accounts_user_id_idx" ON "accounts" ("user_id");

CREATE INDEX "verifications_identifier_idx"
  ON "verifications" ("identifier");

-- The pinned generator omits these operational invariants. AlphaNet adds them
-- without changing Better Auth's expected columns or lifecycle semantics.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_not_blank"
    CHECK (length(btrim("token")) > 0);

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_identity_not_blank"
    CHECK (
      length(btrim("provider_id")) > 0
      AND length(btrim("account_id")) > 0
    ),
  ADD CONSTRAINT "accounts_provider_account_unique"
    UNIQUE ("provider_id", "account_id");

ALTER TABLE "verifications"
  ADD CONSTRAINT "verifications_values_not_blank"
    CHECK (
      length(btrim("identifier")) > 0
      AND length(btrim("value")) > 0
    );

CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");

CREATE INDEX "verifications_expires_at_idx"
  ON "verifications" ("expires_at");

CREATE INDEX "verifications_value_idx"
  ON "verifications" ("value");

COMMENT ON SCHEMA auth IS
  'Better Auth 1.6.23 persistence. Managed only through reviewed AlphaNet migrations.';

COMMENT ON TABLE "users" IS
  'Private human authentication identities. Agents are platform domain records, never auth users.';

COMMENT ON TABLE "accounts" IS
  'Credential and OAuth provider accounts owned by Better Auth; provider tokens are encrypted by the application.';
