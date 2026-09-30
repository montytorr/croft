-- ===========================================================================
-- 073: the Cairn key is stored sealed
--
-- `cairn_connection.api_key` held the key exactly as an administrator typed
-- it, so anyone who could read a backup or the table could act as this
-- instance in Cairn. The app now seals it (AES-256-GCM, src/lib/secret-box.ts)
-- as `v1:<iv>:<tag>:<ciphertext>` under CROFT_SECRET_KEY.
--
-- The column keeps its name: the SQL has no key and cannot encrypt, so a key
-- already stored stays readable as it is and is MARKED instead. The app reads
-- a marked key once, as plaintext, and seals it in place on that read or on
-- the next save of the connection, whichever comes first. The mark, not the
-- text's shape, decides how a value is read, so a plaintext key that happens
-- to look sealed is still read as what it is.
-- ===========================================================================

alter table cairn_connection
  add column if not exists api_key_plaintext boolean not null default false;

-- Nothing sealed a key before this migration, so every stored key is plaintext.
update cairn_connection
   set api_key_plaintext = true
 where api_key is not null;

comment on column cairn_connection.api_key is
  'Sealed by the app: v1:<iv>:<tag>:<ciphertext>, AES-256-GCM under CROFT_SECRET_KEY. '
  'Plaintext only while api_key_plaintext is true (stored before 073).';

comment on column cairn_connection.api_key_plaintext is
  'The key was stored before 073 and is still plaintext; the app seals it on its next read or save.';
