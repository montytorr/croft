-- Cairn handoff and status refresh use the agent machine's Cairn credentials.
-- Remove the retired instance-wide connection, including any stored key.
-- Existing todo links and their recorded statuses/outcomes stay intact.
drop table if exists cairn_connection;
