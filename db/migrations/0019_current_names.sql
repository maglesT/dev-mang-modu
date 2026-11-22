-- Display round 22 Nov 2026: current product names. The automatic reporters' areas and names and the LIMS area follow
-- the products' names (TrueBatch Tablets, TrueBatch Tablets Packing, TrueBatch Liquids, QLIMS). A renamed area keeps its
-- id, so every deviation filed in it stays in it; where the new name already exists nothing is renamed.
update areas a set name = v.new_name
  from (values
    ('TrueBatch (automatic)', 'TrueBatch Tablets (automatic)'),
    ('TrueBatch Packing (automatic)', 'TrueBatch Tablets Packing (automatic)'),
    ('TrueBatch Oral Liquids (automatic)', 'TrueBatch Liquids (automatic)'),
    ('TrueBatch Oral Liquids Packing (automatic)', 'TrueBatch Liquids Packing (automatic)'),
    ('QC laboratory (Medhanta LIMS)', 'QC laboratory (QLIMS)')
  ) as v(old_name, new_name)
  where a.name = v.old_name and not exists (select 1 from areas x where x.name = v.new_name);
update users u set full_name = v.new_name
  from (values
    ('truebatch.auto', 'TrueBatch Tablets (automatic report)'),
    ('truebatch_packing.auto', 'TrueBatch Tablets Packing (automatic report)'),
    ('truebatch_liquids.auto', 'TrueBatch Liquids (automatic report)'),
    ('truebatch_liquids_packing.auto', 'TrueBatch Liquids Packing (automatic report)')
  ) as v(username, new_name)
  where u.username = v.username;
