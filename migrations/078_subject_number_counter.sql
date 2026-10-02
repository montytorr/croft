-- 078: a deleted subject's number is never handed out again.
--
-- 070 numbered a new subject max(number) + 1. That was gapless by design, but
-- since subjects can be deleted (0.6.0), deleting the newest one freed its
-- number: S-15 was filed, deleted, and filed again as an unrelated subject.
-- Everything that still cites the old S-15 (a Cairn note, a link, a log)
-- would then name the wrong subject.
--
-- A counter that only goes up, as projects.task_counter does for tasks. It
-- stays gapless otherwise: the counter's update rolls back with a failed
-- insert, so the only holes are deletions, and a hole now means exactly that.
-- The row lock on the counter serialises concurrent inserts, which the
-- advisory lock did before.

create table if not exists subject_number_counter (
  singleton    boolean primary key default true check (singleton),
  last_number  integer not null check (last_number >= 0)
);

insert into subject_number_counter (singleton, last_number)
select true, coalesce(max(number), 0) from subjects
on conflict (singleton) do update
  set last_number = greatest(subject_number_counter.last_number, excluded.last_number);

create or replace function assign_subject_number() returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    update subject_number_counter
       set last_number = last_number + 1
     where singleton
    returning last_number into new.number;
  else
    -- An explicit number (an import) moves the counter past it.
    update subject_number_counter
       set last_number = greatest(last_number, new.number)
     where singleton;
  end if;
  return new;
end
$$;
