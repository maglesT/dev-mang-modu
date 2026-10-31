# Decisions

Small decisions made by the developer under the brief, and owner decisions. Owner decisions say so.

| ID | Date | Decision |
|----|------|----------|
| D-01 | 2026-10-31 | Scope = owner-approved defaults of 31 Oct 2026 (standalone, free-text batch numbers, CAPA kept simple inside the deviation, fixed roles, one site, on-screen alerts, no email). *Owner defaults.* |
| D-02 | 2026-10-31 | EU GMP Chapter 1 rev 3 (in force 31 Jan 2013) fetched from the official EU site. No need to ask the owner. |
| D-03 | 2026-10-31 | Official source files are kept out of git (`sources/` is git-ignored). Only title, version, URL, sha256 and paraphrases are committed, as in the logbook. |
| D-04 | 2026-10-31 | Only in-force texts are cited. The 2025 EU Annex 11 / Ch4 drafts, PIC/S, GAMP 5, ICH Q9 and FDA OOS guidance are not used. |
| D-05 | 2026-10-31 | Docs layout copied from the logbook: 01 sources, 02 requirements, 03 register, 04 verification, 05 architecture and slices, decisions, handover, traceability. |
| D-06 | 2026-10-31 | Code reuse (passed on by the lead session as an owner instruction, not yet confirmed by the owner in this session): the app skeleton, accounts, roles, sessions, lockout, audit trail, e-signature, corrections, integrity, backup, traceability and UI come from `maglesT/maglest-pharma-logbook`, copied and adapted (no shared library). Anything newer from `maglesT/mater-managemen-syst` is used once it is attached. `maglesT/ebmr` is a domain reference only. Each reused rule is re-checked against this product's clauses. Copying starts with the first slice, after the plan is approved. |
| D-07 | 2026-10-31 | Revised Schedule M fetched from the official CDSCO URL (272 pages; sha256 9187…d271, the same file the logbook used). Part I extracted with `pdftotext -layout`. Attaching `maglesT/ebmr` is no longer needed for sources. |
