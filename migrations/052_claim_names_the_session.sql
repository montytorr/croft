-- ===========================================================================
-- 052: a claim says which session holds it, not just which human
--
-- `claimed_by` is an actorLabel — `claude-code · cal@example.com` — and every
-- Claude Code session on a machine writes exactly that string. Four of them
-- run here at once. The claim itself is fine: claim_task_atomic updates only
-- `where claimed_by is null or heartbeat_at < p_stale_before`, so a second
-- session is refused with a 409. It is everything AROUND the claim that reads
-- the label and believes it names a worker.
--
--   - `release` matched on the label and released somebody else's claim.
--   - `--mine` answered "this human's agents" while looking like "this session".
--   - checkpointHeldTasks stamped its summary onto every task the LABEL held,
--     so one session's afternoon landed on another session's tasks. CROFT-182
--     fixed the version of this that stamped untouched tasks; this is the same
--     bug arriving through identity instead of through the file list.
--   - and nobody could answer "which session is holding this", which cost a
--     duplicated implementation today: PR #50 and PR #53 are the same fix,
--     written forty minutes apart by two sessions that could not see each
--     other.
--
-- One nullable column, and deliberately nothing else. No signature change on
-- claim_task_atomic, which is the hottest path in the product and the one
-- thing here that was never broken.
--
-- NULL means "a claim from before this, or from a runtime that cannot name
-- its session". Every reader treats NULL as "cannot tell" and falls back to
-- today's behaviour, because a lock that starts refusing work it used to
-- allow is worse than the ambiguity it replaces.
-- ===========================================================================

alter table tasks add column if not exists claimed_session text;

comment on column tasks.claimed_session is
  'Which session holds the claim, when the runtime can name one. NULL means unknown, never "nobody".';
