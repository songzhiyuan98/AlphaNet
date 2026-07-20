\set ON_ERROR_STOP on

-- A bind-mounted shell file can be marked executable yet live on a no-exec
-- filesystem in Docker Desktop. Run it explicitly through Bash from psql so a
-- fresh database initializes consistently on both macOS and Linux.
\! /bin/bash /opt/alphanet/infra/postgres-init.sh

\if :SHELL_ERROR
  \echo 'AlphaNet database bootstrap failed.'
  \quit 3
\endif
