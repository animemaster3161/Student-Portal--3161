-- Run once in the Supabase SQL Editor to allow users to rotate their own
-- encrypted E2EE key backup after the browser verifies the current password
-- and current security keyword.

create or replace function public.rotate_my_key_backup(
  p_expected_salt text,
  p_wrapped_key text,
  p_salt text,
  p_iv text,
  p_iterations integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  if p_expected_salt is null
    or nullif(btrim(p_wrapped_key), '') is null
    or nullif(btrim(p_salt), '') is null
    or nullif(btrim(p_iv), '') is null
    or p_iterations is null
    or p_iterations not between 100000 and 1000000 then
    raise exception 'Invalid encrypted key backup.' using errcode = '22023';
  end if;

  update public.key_backups
    set wrapped_key = p_wrapped_key,
        salt = p_salt,
        iv = p_iv,
        iterations = p_iterations
    where user_id = v_uid
      and salt = p_expected_salt;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'The key backup changed or is missing. Reload and try again.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.rotate_my_key_backup(text, text, text, text, integer) from public;
grant execute on function public.rotate_my_key_backup(text, text, text, text, integer) to authenticated;
