-- FP guard: payload COPY chứa data giống `verb ... schema.` KHÔNG được coi là câu lệnh.
-- Đích `app` phải CHẤP NHẬN (payload bị bỏ, chỉ câu lệnh thật soi).
SET statement_timeout = 0;
COPY app."Order" (note, id) FROM stdin;
DROP public.x here is only a note value	1
ship to storage.objects please	2
call auth.example.com now	3
\.
ALTER TABLE app."Order" ADD COLUMN extra text;
