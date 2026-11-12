-- D-50 (owner 2026-11-12, Logbook D-37): a limit the Logbook finds missed (overdue cleaning, preventive maintenance,
-- calibration or requalification) is filed here as a deviation on its own. The Logbook publishes each missed limit once
-- in its report.overdue_v1 with the report text; Deviations reads it through its platform link and files each record
-- once, as its automatic reporter, in the area "Logbook (automatic)". QA classifies it like any other report.
-- source_ref names the record a deviation was filed for ('logbook:overdue:<event_id>'): unique, so a record is never
-- filed twice, and published in deviation_v1 so the Logbook can show the number.
alter table deviations add column source_ref text unique check (source_ref is null or length(source_ref) between 3 and 200);
grant insert (source_ref) on deviations to deviations_app;

-- The automatic reporter (users: no core employee, so it can never sign in; no password) and the area "Logbook (automatic)"
-- are made by the app at the first automatic report, not here: the move of a standalone installation needs empty tables.

do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- deviation_v1 gains title and source_ref at the end (columns are added, never removed or renamed; migration 0013).
create or replace view deviation_v1 with (security_barrier) as
select d.number, d.step as status, d.classification, d.reported_at as opened_at,
  case when d.step = 'closed' then (
    select g.signed_at from latest_sections l
    join signatures g on g.object_type = 'section' and g.object_id = l.id and g.meaning = 'closed'
    where l.deviation_id = d.id and l.kind = 'closure') end as closed_at,
  b.product, b.batch, b.batch_norm, b.outcome,
  now() as read_at,
  greatest(d.reported_at,
    (select max(s.saved_at) from sections s where s.deviation_id = d.id),
    (select max(g.signed_at) from sections s join signatures g on g.object_type = 'section' and g.object_id = s.id
     where s.deviation_id = d.id)) as data_as_of,
  (select r.data->>'title' from latest_sections r where r.deviation_id = d.id and r.kind = 'report') as title,
  d.source_ref
from deviations d
left join (batches b join latest_sections bs on bs.id = b.section_id) on b.deviation_id = d.id;

reset search_path;
