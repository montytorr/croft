-- ---------------------------------------------------------------------------
-- A summariser run, by the same test the recorder applies (CROFT-321).
--
-- 065 matched Croft's own prompt only ("…in an engineering memory"). The
-- recorder's SUMMARISER_PROMPT (hooks/croft-session-end.mjs) has matched any
-- tool's since CROFT-287 — Quarry's "…in a sales memory" is the same run under
-- another name — so the vitals counted those as work. Same pattern, both sides.
-- ---------------------------------------------------------------------------
create or replace function session_is_summariser(p_request text)
returns boolean
language sql
immutable
as $$
  select coalesce(ltrim(p_request) ~* '^You are writing one entry in an? [a-z0-9_ -]*memory\y', false)
$$;
