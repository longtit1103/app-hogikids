-- PostgreSQL dump touching a Supabase system schema (MUST be rejected)
SET statement_timeout = 0;
CREATE SCHEMA app;
CREATE TABLE app."Order" (id bigint NOT NULL);
TRUNCATE storage.objects;
