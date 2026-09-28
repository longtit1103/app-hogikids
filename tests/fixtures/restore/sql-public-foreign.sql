-- Pre-migration plain dump of the OLD public-schema DB (H3).
-- Deliberately has no schema-DDL and touches no Supabase system schema, so guards
-- (a)+(b) both pass it; only the symmetric guard (e) rejects it for target `app`,
-- while target `public` must still ACCEPT it (backward compat). The quoted note
-- `public.square` must not trigger a false reject for target `public`.
SET statement_timeout = 0;
CREATE TABLE public."Order" (id bigint NOT NULL, note text);
INSERT INTO public."Order" (id, note) VALUES (1, 'ship to public.square');
ALTER TABLE public."Order" ADD COLUMN extra text;
