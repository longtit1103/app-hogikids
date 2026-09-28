-- PostgreSQL database dump (full-DB — MUST be rejected)
SET statement_timeout = 0;
CREATE SCHEMA app;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid NOT NULL);
CREATE TABLE app."Order" (id bigint NOT NULL);
