-- Display round 22 Nov 2026 (second pass): the liquids products are called "TrueBatch Oral Liquids" (undoes the
-- rename of 0019 for them) and the Logbook is called LEAD. Areas keep their ids; a name already taken is not renamed.
update areas a set name = v.new_name
  from (values
    ('TrueBatch Liquids (automatic)', 'TrueBatch Oral Liquids (automatic)'),
    ('TrueBatch Liquids Packing (automatic)', 'TrueBatch Oral Liquids Packing (automatic)'),
    ('Logbook (automatic)', 'LEAD (automatic)')
  ) as v(old_name, new_name)
  where a.name = v.old_name and not exists (select 1 from areas x where x.name = v.new_name);
update users u set full_name = v.new_name
  from (values
    ('truebatch_liquids.auto', 'TrueBatch Oral Liquids (automatic report)'),
    ('truebatch_liquids_packing.auto', 'TrueBatch Oral Liquids Packing (automatic report)'),
    ('logbook.auto', 'LEAD (automatic report)')
  ) as v(username, new_name)
  where u.username = v.username;
