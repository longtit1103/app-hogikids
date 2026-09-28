-- PostgreSQL database dump (plain, schema `app` only)
SET statement_timeout = 0;
DROP SCHEMA IF EXISTS "app" CASCADE;
CREATE SCHEMA app;
ALTER SCHEMA app OWNER TO hogikids;
CREATE TABLE app."Order" (id bigint NOT NULL, note text);
INSERT INTO app."Order" (id, note) VALUES (1, 'login at auth.example.com');
INSERT INTO app."Order" (id, note) VALUES (2, 'visit www.shop.net today');
COPY app."Order" (id, note) FROM stdin;
3	\N
\.
ALTER TABLE app."Order" ADD COLUMN extra text;
