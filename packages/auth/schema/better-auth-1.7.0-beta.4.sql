create table "users" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null, "image" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "sessions" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null, "ip_address" text, "user_agent" text, "user_id" uuid not null references "users" ("id") on delete cascade);

create table "accounts" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" uuid not null references "users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamptz, "refresh_token_expires_at" timestamptz, "scope" text, "password" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null);

create table "verifications" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "oauth_jwks" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "public_key" text not null, "private_key" text not null, "created_at" timestamptz not null, "expires_at" timestamptz);

create table "oauth_clients" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "client_id" text not null unique, "client_secret" text, "disabled" boolean, "skip_consent" boolean, "enable_end_session" boolean, "subject_type" text, "scopes" jsonb, "user_id" uuid references "users" ("id") on delete cascade, "created_at" timestamptz, "updated_at" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "software_id" text, "software_version" text, "software_statement" text, "redirect_uris" jsonb not null, "post_logout_redirect_uris" jsonb, "token_endpoint_auth_method" text, "jwks" text, "jwksUri" text, "grant_types" jsonb, "response_types" jsonb, "public" boolean, "type" text, "require_pkce" boolean, "reference_id" text, "metadata" jsonb);

create table "oauth_refresh_tokens" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "client_id" text not null references "oauth_clients" ("client_id") on delete cascade, "session_id" uuid references "sessions" ("id") on delete set null, "user_id" uuid not null references "users" ("id") on delete cascade, "reference_id" text, "resources" jsonb, "expires_at" timestamptz not null, "created_at" timestamptz not null, "revoked" timestamptz, "auth_time" timestamptz, "scopes" jsonb not null);

create table "oauth_access_tokens" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "client_id" text not null references "oauth_clients" ("client_id") on delete cascade, "session_id" uuid references "sessions" ("id") on delete set null, "user_id" uuid references "users" ("id") on delete cascade, "reference_id" text, "resources" jsonb, "refresh_id" uuid references "oauth_refresh_tokens" ("id") on delete cascade, "expires_at" timestamptz not null, "created_at" timestamptz not null, "scopes" jsonb not null);

create table "oauth_consents" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "client_id" text not null references "oauth_clients" ("client_id") on delete cascade, "user_id" uuid references "users" ("id") on delete cascade, "reference_id" text, "resources" jsonb, "scopes" jsonb not null, "created_at" timestamptz not null, "updated_at" timestamptz not null);

create index "sessions_user_id_idx" on "sessions" ("user_id");

create index "accounts_user_id_idx" on "accounts" ("user_id");

create index "verifications_identifier_idx" on "verifications" ("identifier");

create index "oauth_clients_user_id_idx" on "oauth_clients" ("user_id");

create index "oauth_refresh_tokens_client_id_idx" on "oauth_refresh_tokens" ("client_id");

create index "oauth_refresh_tokens_session_id_idx" on "oauth_refresh_tokens" ("session_id");

create index "oauth_refresh_tokens_user_id_idx" on "oauth_refresh_tokens" ("user_id");

create index "oauth_access_tokens_client_id_idx" on "oauth_access_tokens" ("client_id");

create index "oauth_access_tokens_session_id_idx" on "oauth_access_tokens" ("session_id");

create index "oauth_access_tokens_user_id_idx" on "oauth_access_tokens" ("user_id");

create index "oauth_access_tokens_refresh_id_idx" on "oauth_access_tokens" ("refresh_id");

create index "oauth_consents_client_id_idx" on "oauth_consents" ("client_id");

create index "oauth_consents_user_id_idx" on "oauth_consents" ("user_id");
