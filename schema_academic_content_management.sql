-- Run once in the Supabase SQL Editor to allow approved academic staff to
-- edit and delete published academic content from admin/subadmin.html.
-- Subjects, chapters, and PYQs stay restricted to primary admins.

alter table public.academic_subjects enable row level security;
alter table public.academic_chapters enable row level security;
alter table public.academic_assignments enable row level security;
alter table public.academic_notices enable row level security;
alter table public.academic_pyqs enable row level security;

grant update, delete on public.academic_subjects to authenticated;
grant update, delete on public.academic_chapters to authenticated;
grant update, delete on public.academic_assignments to authenticated;
grant update, delete on public.academic_notices to authenticated;
grant update, delete on public.academic_pyqs to authenticated;

drop policy if exists "Primary admins can edit academic subjects" on public.academic_subjects;
create policy "Primary admins can edit academic subjects"
  on public.academic_subjects for update to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ))
  with check (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ));

drop policy if exists "Primary admins can delete academic subjects" on public.academic_subjects;
create policy "Primary admins can delete academic subjects"
  on public.academic_subjects for delete to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ));

drop policy if exists "Primary admins can edit academic chapters" on public.academic_chapters;
create policy "Primary admins can edit academic chapters"
  on public.academic_chapters for update to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ))
  with check (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ));

drop policy if exists "Primary admins can delete academic chapters" on public.academic_chapters;
create policy "Primary admins can delete academic chapters"
  on public.academic_chapters for delete to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ));

drop policy if exists "Staff can edit academic assignments" on public.academic_assignments;
create policy "Staff can edit academic assignments"
  on public.academic_assignments for update to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role in ('admin', 'subadmin')
  ))
  with check (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role in ('admin', 'subadmin')
  ));

drop policy if exists "Staff can delete academic assignments" on public.academic_assignments;
create policy "Staff can delete academic assignments"
  on public.academic_assignments for delete to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role in ('admin', 'subadmin')
  ));

drop policy if exists "Staff can edit academic notices" on public.academic_notices;
create policy "Staff can edit academic notices"
  on public.academic_notices for update to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role in ('admin', 'subadmin')
  ))
  with check (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role in ('admin', 'subadmin')
  ));

drop policy if exists "Staff can delete academic notices" on public.academic_notices;
create policy "Staff can delete academic notices"
  on public.academic_notices for delete to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role in ('admin', 'subadmin')
  ));

drop policy if exists "Primary admins can edit academic PYQs" on public.academic_pyqs;
create policy "Primary admins can edit academic PYQs"
  on public.academic_pyqs for update to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ))
  with check (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ));

drop policy if exists "Primary admins can delete academic PYQs" on public.academic_pyqs;
create policy "Primary admins can delete academic PYQs"
  on public.academic_pyqs for delete to authenticated
  using (exists (
    select 1 from public.academic_staff s
    where s.user_id = auth.uid() and s.role = 'admin'
  ));
