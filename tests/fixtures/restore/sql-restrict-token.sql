--
-- PostgreSQL database dump
--

\restrict WlT2ag4P349aIpVlWq4qeOpA4sht4cYrc34Ff3yqo5LPjwO9PcFueEnZMueIVOc

-- Dumped by pg_dump version 15.18 (Debian 15.18-1.pgdg12+1)

SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE SCHEMA app;
CREATE TABLE app."Order" (id bigint NOT NULL, note text);
COPY app."Order" (id, note) FROM stdin;
1	ghi chu
2	\N
\.
ALTER TABLE ONLY app."Order" ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);

--
-- PostgreSQL database dump complete
--

\unrestrict WlT2ag4P349aIpVlWq4qeOpA4sht4cYrc34Ff3yqo5LPjwO9PcFueEnZMueIVOc
