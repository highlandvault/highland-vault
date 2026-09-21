#!/bin/sh
# LOCAL DEVELOPMENT bootstrap. Runs once, when the postgres volume is first created.
#
#   hv_owner  owns the database and runs migrations. CREATEDB lets the
#             integration-test harness create and drop throwaway databases.
#   hv_app    runtime role for api/worker: DML only, no DDL.
#
# Production roles are provisioned by operations, not by this script.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$HV_OWNER_PASSWORD" -v app_pw="$HV_APP_PASSWORD" -v db="$HV_DB_NAME" <<'SQL'
CREATE ROLE hv_owner LOGIN CREATEDB PASSWORD :'owner_pw';
CREATE ROLE hv_app LOGIN PASSWORD :'app_pw';
CREATE DATABASE :"db" OWNER hv_owner;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$HV_DB_NAME" -v db="$HV_DB_NAME" <<'SQL'
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO hv_app;
GRANT USAGE ON SCHEMA public TO hv_app;
-- Tables and sequences created later by hv_owner (i.e. by migrations) are usable by hv_app.
-- Append-only tables will REVOKE UPDATE/DELETE from hv_app in their own migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE hv_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hv_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hv_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hv_app;
SQL
