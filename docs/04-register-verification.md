# Register verification (for deliverable (c))

Status: 2026-10-31. Covers register draft 1 → draft 2.

## 1. Method (software and AI only; no human GMP expert)

1. **Program check:** `scripts/check-register.mjs` reads `compliance/register-checks.json`.
   For each rule and clause it checks that the clause exists in the official source text and
   that the short quoted phrase appears inside that clause. Sources are the files listed in
   `01-source-documents.md` (git-ignored; fetched by URL, sha256 recorded).
2. **Two independent AI verifiers** read the register, the requirements and the source texts,
   without being told the expected answer:
   - **V1:** US texts (21 CFR 211, Part 11, SA, DI).
   - **V2:** EU GMP Ch1/4/5, Annex 11, Schedule M Part I.

   Each checked meaning, over-strictness, insufficiency, missing clauses and the dropped list.
3. **Resolution:** I resolved every finding within the owner's principles (strictest wins,
   least-strict implementation). Findings that change an approved requirement are flagged
   for the owner in register section E.

## 2. Program check result

| Run | Checks | Result |
|-----|--------|--------|
| Draft 1 | 50 | 50/50 pass |
| Draft 2 | 69 | 69/69 pass |

## 3. Findings and resolutions

| # | By | Rule | Finding | Resolution in draft 2 |
|---|----|------|---------|-----------------------|
| 1 | V1 | DV-02 | 211.100(b) needs a *justification*, not approval. There was no justification field. | 211.100(b) moved to DV-01. Planned deviations get a required "reason" at report; for unplanned ones, impact and conclusion are the justification. |
| 2 | V1 | DV-06 | 211.192 is not unconditional ("may have been associated"); the "FDA is stricter" claim was wrong. | Reason corrected: neither is stricter, but 211.192 adds "whether or not distributed". Implementation unchanged (applied to all deviations). |
| 3 | V1 | DV-03 | 211.192 sets a floor: "minor" cannot mean no investigation. | Stated in DV-03; every deviation still needs root cause and conclusion. |
| 4 | V1 | DV-10 | DI Q7: QA's review covers the audit trail; closure did not show it. | Closing step shows the history on the same screen; CP-10 added. |
| 5 | V1 | DV-12 | A free-text product filter silently misses spelling variants. | The filter shows every distinct spelling it matched. Product is also confirmed at classification (DV-20). |
| 6 | V1 | DV-17 | ID + password at every signing is more than 11.200(a)(1)(i) needs. | Kept as reused from the logbook (simpler, one dialog); relaxation noted in DV-17. |
| 7 | V1 | DV-17 | An Admin could grant themselves QA, or take over a new account through its temporary password (11.200(a)(3), two-person collaboration). | Admin cannot change their own roles; first login and password changes are audited; temporary-password handover is in CP-03. |
| 8 | V1 | DV-18 | 11.300(d) covers *any* attempt, including failed signing; an alert seen only by logged-in users is not reliable. | Failed signing attempts count. The alert stays until a named person acknowledges it (CP-03). |
| 9 | V1, V2 | DV-20 | QA's closure review was called the second-person check, but D-09 let one QA user report and close. Free-text product/batch cannot be checked by the system (SchM 17.2.8 "independently checked"), and closure comes after release. | QA confirms product and batch at **classification**, and the classifier cannot be the reporter. D-09 is otherwise still dropped. Flagged to the owner (E1). |
| 10 | V1 | DV-22 | 211.68(b): backups "exact and complete" and secure; CI restore alone does not show that. | Backup script writes a SHA-256 and copies to an off-host location; restore check verifies the checksum. |
| 11 | V1 | CP-06 | P11 11.30 is for open systems; a hosted system is still closed. | 11.30 removed from CP-06; section C cites 11.3(b)(4). |
| 12 | V1 | CP-05 | Missing 211.188(b)(12): the batch record includes any 211.192 investigation. | Added to CP-05. |
| 13 | V1 | CP-02 | Missing 211.25(a) training. | Added. |
| 14 | V2 | DV-08, DV-10 | Register out of date with D-13 / D-14 (actions inside the deviation; closure blocked by unverified actions). | Rewritten for CAPA records and the D-14 closure rule. V2 found no EU/SchM clause tying closure to CAPA completion. |
| 15 | V2 | DV-08 | SchM 2.3.3 / C1 1.11 concern product quality review CAPAs, not deviation CAPAs. | Removed as DV-08 basis; 2.3.3 kept under CP-11. DV-08 stands on SchM 1.5(s), 3.1(6), C1 1.8(vii). |
| 16 | V2 | DV-09 | An EU "should" / Q10 cannot relax a SchM "shall be monitored". | Basis changed to SchM 2.2(b) (effort commensurate with risk). Options: a dedicated check, or "monitored through trend and quality review, because…". There is no plain "not needed". Trend shows CAPA outcomes. Flagged to the owner (E2). |
| 17 | V2 | DV-11, CP-05 | Wrong number: SchM 19.4(f) is 19.3(f). Missing SchM 11.3.9(e) (deviations notified before release) and C4 4.27. | Corrected and added. |
| 18 | V2 | DV-14 | The *Corrected* password signature is more than "signed and dated" needs. "Reason" is "where appropriate" in C4/SchM, but A11 9 asks for it. | Dropped the *Corrected* signature: an authenticated, audit-trailed change with a required reason (A11 9 cited). |
| 19 | V2 | DV-22 | C4 4.11 retention: also 5 years after certification. | Cited. No effect, since nothing is deleted. |
| 20 | V2 | DV-21, DV-15 | Citation gaps: A11 8.2, A11 12.4. | Added. |
| 21 | V2 | DV-01, DV-04 | Citation gap: C1 1.9(iv), SchM 19.3(d) ("any deviations … investigated"), the basis for minor ones. | Added. |
| 22 | V2 | CP-03, CP-08 | A11 12.3 does not require periodic access review; SchM 20.10 does not require continuity. | Citations removed (12.3 stays under DV-18; 20.10 moved to section C). |
| 23 | V2 | new | A11 9: audit trails reviewed regularly. | CP-10. |
| 24 | V2 | CP-07 | SchM 20.5, 20.8 and A11 10 cover configuration changes too. | CP-07 covers settings and list changes and cites 20.5/20.8. This is also why "QA approval of settings" can stay dropped. |
| 25 | V2 | new | CAPA register now holds audit/complaint CAPAs: SchM 10.1, 6.1, 2.3.3. | CP-11 (site follows up; product provides the register). |
| 26 | V2 | E2 | "No CAPA" for minor deviations is fine if "significant" = major + critical and the reason points to the immediate action. | DV-08 and CP-04 updated. |
| 27 | V2 | DV-02 | QC involvement "when appropriate" should be defined. | In CP-04. |

## 4. Agreement between verifiers

- Both found that the D-09 drop undermined the DV-20 reasoning (finding 9). Resolved the same way.
- V2 confirmed every "which text is stricter" claim except DV-06, which V1 corrected (finding 2).
- Section D: V1 found no US clause broken by any dropped item. V2 confirmed the drops, with the conditions now met by findings 9, 16 and 24.

## 5. Next verification

At each slice, the rule-ID tests prove the implementation, and `npm run traceability -- --check`
fails CI if a DV rule has no test. The program check is re-run whenever the register changes.
