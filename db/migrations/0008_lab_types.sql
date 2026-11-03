-- S14 (D-36): Admin marks a deviation type as a lab / OOS type; its investigations need the KT checklist.
alter table deviation_types add column lab_oos boolean not null default false;
grant update (lab_oos) on deviation_types to deviations_app;
