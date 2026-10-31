# Deliverable (c): Minimum compliance register (draft 2)

Status: draft for owner approval · 2026-10-31. Draft 1 was checked by a program (clause
exists, quoted words appear in it) and by two independent AI verifiers (US texts; EU GMP
and Schedule M). Every finding and how draft 2 handles it is in `04-register-verification.md`.
Draft 2 also covers the CAPA register (D-13) and the closure rule (D-14), both owner-confirmed.

## How rules got in (owner's test)

1. **Binding source required:** 21 CFR 211 and Part 11, EudraLex Vol 4 (Ch1, Ch4, Ch5,
   Annex 11), or Revised Schedule M Part I. FDA guidance and ICH Q10 may only relax or
   clarify a rule. A weaker EU "should" or a guidance text never relaxes a Schedule M "shall".
2. **Relevance:** the clause governs recording, approving, investigating or closing a
   deviation, or taking a CAPA to completion, or the e-records and e-signatures of those.
3. **Strictest requirement, least-strict implementation** that satisfies FDA, EU and
   Schedule M together.
4. **Removability:** "Why required" names the clause that breaks if the rule is dropped.
   Candidates that failed are in section D.

**Result: 22 product rules (DV-01 to DV-22) and 11 customer-procedure rules (CP-01 to CP-11).**

**Source keys:** **211**, **P11**: 21 CFR Parts 211 and 11 (eCFR 2026-10-28). **C1 / C4 /
C5**: EudraLex Vol 4 Part I, Chapters 1, 4 and 5. **A11**: Annex 11 (2011). **SchM**: Revised
Schedule M Part I (gazette sha256 9187…d271). Guidance: **SA**, FDA Part 11 Scope and
Application (2003); **DI**, FDA Data Integrity Q&A (2018); **Q10**, ICH Q10.

Machine-checked clause/phrase pairs for every rule: `compliance/register-checks.json`
(run `node scripts/check-register.mjs`).

## A. Product rules

### Deviations

| ID | Rule | Binding clauses | Why required (breaks if dropped) | Least-strict implementation | Test |
|----|------|-----------------|----------------------------------|-----------------------------|------|
| DV-01 | Every deviation is recorded and justified: what happened, where, when, product and batch, immediate action, and why it deviated. | 211.100(b); C1 1.8(vii), 1.9(iv); SchM 1.5(s), 3.1(6), 19.3(d) | 211.100(b) ("recorded and justified"); C1 1.9(iv) / SchM 19.3(d) (*any* deviation recorded). | One *Report* form for every user. Required: planned/unplanned, title, description, area, event time, product and batch (free text, "none" allowed), immediate action. **Justification:** for a planned deviation, a required "reason for the planned deviation" at report; for an unplanned one, the impact assessment (DV-03) and conclusion (DV-07) are the justification. The server assigns `DEV-YYYY-NNNN`, never reused. | Report refused without a required field (planned: without reason); numbers unique. |
| DV-02 | A deviation is approved in writing by a designated person, with QC involved when appropriate. A planned deviation is approved before it is carried out. | C5 5.15; SchM 18.2.2 | SchM 18.2.2, C5 5.15. | Only QA approves. Unplanned: the QA *Closed* signature (DV-10) is the written approval. Planned: a QA *Approved* signature is required before it may proceed; until then it shows "Not approved: do not proceed". QA may *Reject* it with a reason. When QC is involved is set in the SOP (CP-04). | Non-QA cannot approve; planned shows "not approved" until signed. |
| DV-03 | Significance and impact are assessed, so the investigation fits the risk. Discrepancies and specification failures are always thoroughly investigated. | C1 1.4(xiv), 1.8(vii); SchM 1.5(s), 2.2(b), 3.1(6); 211.192 | C1 1.4(xiv) / SchM 1.5(s) (an *appropriate level*); C1 1.8(vii) / SchM 3.1(6) apply to *significant* deviations, so significance must be decided. 211.192 sets the floor: "minor" never means no investigation. | QA sets minor / major / critical and writes a short impact assessment. No scoring. Every deviation, minor included, still needs a root cause and a conclusion (DV-04, DV-07). | Investigation not reachable before classification. |
| DV-04 | The investigation looks for the root cause at a suitable level. If it cannot be confirmed, the most likely root cause is identified. | C1 1.4(xiv), 1.9(iv); SchM 1.5(s), 19.3(d) | SchM 1.5(s) ("shall" identify the most likely root causes; C1 only "consideration should be given"). | Root cause text required for every deviation. Tick "true root cause not confirmed; most likely cause stated". | Investigation cannot be signed without root cause. |
| DV-05 | A conclusion of human error is justified, after making sure process, procedure or system causes were not overlooked. | C1 1.4(xiv) | C1 1.4(xiv) (the only binding clause on human error). | Ticking "human error" makes a justification field required. | Human error without justification refused. |
| DV-06 | The investigation extends to other batches of the same product and other products that may be associated, whether or not the batch was distributed. | 211.192; SchM 18.5.12 | 211.192 and SchM 18.5.12. Both limit it to batches that "may have been associated" / "if necessary", so neither is stricter. 211.192 adds "whether or not the batch has already been distributed". | Applied to every deviation (one rule is simpler than deciding which are discrepancies). Before signing, the investigator lists each other batch/product checked with an outcome, or states why none could be associated. Listed batches feed the batch lookup (DV-11). | Signing refused with neither list nor statement. |
| DV-07 | A written record of the investigation includes the conclusions and the follow-up. | 211.192; SchM 18.5.12 | Both. | Conclusion required to sign *Investigation complete*. Follow-up = the CAPAs raised from it (DV-08) and the closure summary (DV-10). | Cannot sign without a conclusion. |
| DV-08 | Appropriate corrective and preventive actions are identified and taken. A significant deviation always gets CAPA. Each CAPA is followed to completion. | SchM 1.5(s), 3.1(6); C1 1.4(xiv), 1.8(vii) | SchM 1.5(s) ("shall be identified and taken"); C1 1.8(vii) / SchM 3.1(6) (CAPA "implemented" for significant deviations). | CAPA records (D-13): number `CAPA-YYYY-NNNN`, source (deviation, internal audit, complaint, other), corrective/preventive, description, owner, due date. Owner marks *Done*; QA signs *Verified*. A **major or critical** deviation needs at least one CAPA before closure. A **minor** one may instead record "no CAPA: the immediate action (DV-01) was appropriate, because…" (SchM 2.2(b) effort commensurate with risk). Open and overdue CAPAs show on every list. | Major deviation cannot close without a CAPA; minor "no CAPA" needs a reason; Done before Verified. |
| DV-09 | The effectiveness of corrective and preventive actions is monitored. | SchM 1.5(s), 2.2(b); C1 1.4(xiv) | SchM 1.5(s) ("shall be monitored", for every CAPA). | At *Verified*, QA chooses: **dedicated check** by a date (result effective / not effective, with a note; QA then closes the CAPA with a *Closed* signature), or **monitored through the trend and quality review, because…** (SchM 2.2(b) scales the effort; it does not remove monitoring). The trend view (DV-12) shows CAPA outcomes per product, so the quality review sees them. | Verify refused without a choice; open check listed; trend shows CAPA outcomes. |
| DV-10 | The quality unit reviews the investigation, including the record's history, and approves the closure. | 211.22(a), 211.192; C5 5.15; SchM 18.2.2 | 211.22(a) (QA makes sure errors were fully investigated); C5 5.15 / SchM 18.2.2 (written approval). DI Q7 clarifies that QA's review covers the audit trail. | Only QA closes, with a closure summary and a *Closed* e-signature. The closing step shows the deviation's history on the same screen. Closure is allowed once the investigation is signed and CAPAs are raised (owner and due date), or "no CAPA" is recorded for a minor deviation (D-14). Open CAPAs do not block closure and show as "Closed · N CAPAs open". QA *Reopen* (with reason) returns it to Investigation. | Non-QA cannot close; close refused before the investigation is signed or, for major/critical, without a CAPA; history shown at closing. |
| DV-11 | Deviations concerning a batch are available to whoever assesses that batch for release, before release. | 211.192; C1 1.9(vi); C4 4.27; SchM 11.3.9(e), 19.3(f) | SchM 11.3.9(e) (deviations notified before any product is released); C1 1.9(vi) / SchM 19.3(f) (product assessment includes deviations). | "Affects batch X" lookup: matches the deviation's own batch and every batch listed under DV-06, with status; open deviations and open CAPAs are flagged. The release decision stays outside the system (CP-05). | Lookup finds a batch listed only as an "other batch"; open ones are flagged. |
| DV-12 | Deviation and CAPA data can be used for the at-least-annual review of investigations and the product quality review. | 211.180(e)(2); SchM 2.3.2(c), (d); C1 1.10(iv) | 211.180(e)(2) (investigations reviewed per product); SchM 2.3.2(d) (including CAPA effectiveness). | List filtered by product and date range; the product filter shows every distinct spelling it matched, so variants are not silently missed. Counts by month split by area, type or classification, plus CAPA counts by source, status and effectiveness outcome. One table, one chart; browser print. | Counts match records; product variants listed. |
| DV-13 | Records are made at the time the action is taken. | 211.100(b); C4 4.8; SchM 17.2.7 | All. | Server time on every save and signature. The user enters the event time separately; both are shown. | Saved time is server time; future event time refused. |

### Electronic records and signatures

| ID | Rule | Binding clauses | Why required | Least-strict implementation | Test |
|----|------|-----------------|--------------|-----------------------------|------|
| DV-14 | Alterations keep the original readable, are attributable and dated, and give a reason. Nothing is deleted. | C4 4.9; SchM 17.2.6; A11 9; P11 11.10(e) | C4 4.9 / SchM 17.2.6 (original readable, signed and dated); A11 9 (reason documented). | Sections and CAPAs are saved as versions. A correction is made by the logged-in user with a required reason: the audit trail records who and when, which meets "signed and dated" electronically. There is no separate *Corrected* password signature. A correction after a signature marks that signature *superseded*, and the step must be signed again. Attachments can only be *withdrawn*, with a reason. The app's DB user has no UPDATE/DELETE on record, signature and audit tables. | Old value visible; reason required; DB refuses delete. |
| DV-15 | A computer-generated, time-stamped audit trail records every creation and change: who, when, old and new value. It cannot be altered and is kept as long as the record. | P11 11.10(e); SchM 17.2.8, 20.4; A11 9, 12.4 | SchM 20.4 (previous entry, person, time), which is stricter than SA enforcement discretion and the risk-based A11 9. | One audit table, written by the server in the same transaction, covering deviations, CAPAs, signatures, users, roles, lists and settings. Shown on each record and in its PDF. (Logbook LB-18.) | Every action writes an audit row; not writable by the app. |
| DV-16 | Signatures show printed name, date/time and meaning, on screen and in print, and are permanently linked to their record. | P11 11.50, 11.70; A11 14 | P11 11.50, 11.70; A11 14. | Stores full name, server time, meaning (*Approved, Rejected, Investigation complete, Verified, Closed, Reopened*), record version and content hash. Shown in IST with the zone label. (Logbook LB-19.) | Fields in view/PDF; altered content fails the hash check. |
| DV-17 | E-signatures are unique to one person, never reused or reassigned, use two components, and their misuse would need two or more people to collaborate. | P11 11.100(a), 11.200(a), 11.300(a), (b) | All. | ID + password at every signing (reused from the logbook; Part 11 would allow password only after the first signing in a session). IDs never renamed or reused. An Admin cannot change their own roles. Temporary passwords must be changed at first login, and first login and password changes are audited. Handing over temporary passwords is CP-03. Password expiry 90 days (default). | Wrong password or other user's ID fails; Admin cannot grant themselves QA; reused ID refused. |
| DV-18 | Only authorised people use the system, with authority checks per action. Access changes are recorded. Any attempted misuse of an ID or password is reported at once. | P11 11.10(d), (g), 11.300(d); 211.68(b); A11 12.1, 12.3, 12.4; SchM 17.2.8, 20.4 | All. | Named accounts; three fixed roles checked on the server per action; Admin cannot report, act or sign; session timeout 15 min. Failed logins **and failed signing attempts** count: 5 in a row lock the account and raise an alert. The alert stays on screen for every Admin and QA user until a named person acknowledges it (who is named in CP-03), plus an audit row. No email. | Each role refused outside its rights; failed signing counts; alert persists until acknowledged. |
| DV-19 | Steps happen in their permitted order. | P11 11.10(f) | 11.10(f). | Server checks: classify before investigate; planned approved before proceeding; investigation signed before closure; CAPA Done before Verified, Verified before effectiveness result, result before CAPA close. | One test per check. |
| DV-20 | Critical manually entered data are independently checked, by a second person or by the system. Input is checked. | SchM 17.2.8, 20.6; A11 6; 211.68(b) | SchM 17.2.8 ("independently checked"); SchM 20.6 / A11 6. | System checks on every field (required, dates in order, no future event time). The free-text **product and batch**, which no system can check, are confirmed by QA at classification ("product and batch checked", a field, not a signature). QA must be someone other than the reporter, so it is a true second person, and it happens before release decisions rely on the lookup. | Reporter cannot classify their own deviation; classification needs the confirmation. |
| DV-21 | Accurate, complete readable copies are available, showing changes since the original entry and the audit trail. | P11 11.10(b); 211.180(c); A11 8.1, 8.2 | P11 11.10(b); A11 8.1, 8.2. | One PDF per deviation (with its CAPAs) and per CAPA: every section with all versions marked, signatures, attachment list and history. Attachments downloadable as stored. Lists and trends print from the browser. | PDF includes versions, signatures and history. |
| DV-22 | Records are protected and retrievable for the whole retention period. Backups are regular, exact, complete and safe from alteration or loss. Stored data are checked, and nothing is silently lost. | P11 11.10(c); 211.68(b), 211.180(a); C4 4.10, 4.11; A11 7.1, 7.2; SchM 17.2.7, 20.4, 20.9 | 211.68(b) (backup exact, complete, secure); SchM 20.9 (no permanent loss); SchM 20.4 (no omissions). | Nothing deleted, which meets every retention period (1 year after expiry, C4 4.11 five years after certification). Each save is all-or-nothing and confirmed on screen. The daily backup script writes a SHA-256 for each backup and copies it to a second, off-host location set at install (default kept 1 year). The restore check verifies the checksum. A nightly integrity check re-reads records and verifies signature hashes. | No delete path; tampered row detected; restore check passes with checksum. |

## B. Customer procedures (required; the product supports them but cannot do them)

| ID | Rule | Binding clauses | Product support |
|----|------|-----------------|-----------------|
| CP-01 | Validate the system for its intended use. | P11 11.10(a); A11 1, 4; SchM 20.1–20.3 | Rule-to-test traceability list from test names, plus the CI test report. |
| CP-02 | Qualified, trained people with defined responsibilities, including those who investigate and approve deviations. | 211.25(a); P11 11.10(i); A11 2 | — |
| CP-03 | Policies: signature accountability, identity check before issuing accounts, certification to FDA, periodic access review, temporary passwords handed directly to the user (Admins never log in as another user), who acknowledges misuse alerts, periodic restore test. | P11 11.10(j), 11.100(b), (c), 11.300(b); A11 7.2 | Signature declaration text; access-list report; restore check script. |
| CP-04 | A written, approved deviation and CAPA procedure: classification criteria ("significant" = major and critical), when QC is involved, who investigates, target times. | 211.100(a), 211.22(d); C4 4.29; C5 5.15; SchM 18.2.2 | Target-date settings and lists match the SOP. |
| CP-05 | The batch release decision takes the batch's deviations into account, and the batch record references any investigation. | 211.188(b)(12), 211.192; C1 1.9(vi); C4 4.27; SchM 11.3.9(e), (f), 19.3(f) | "Affects batch X" lookup (DV-11) and the deviation PDF. |
| CP-06 | Supplier agreement and assessment. | A11 3 | Supplier documentation pack. |
| CP-07 | Change control, incident management and periodic evaluation of the system, including **configuration changes** (target-date settings, area and type lists). Written procedures for operating and maintaining the system. | A11 10, 11, 13; P11 11.10(k); SchM 20.5, 20.7, 20.8 | Release notes per version; an audit row for every software version change and every settings or list change. |
| CP-08 | Business continuity: controlled paper deviation forms when the system is down, then entered with the paper form number. | A11 16 | The event time is entered separately from the report time (DV-13). |
| CP-09 | Management and product quality reviews that use deviation and CAPA data, including CAPA effectiveness. | 211.180(e); C1 1.6, 1.10, 1.11; SchM 1.6, 2.3 | Trend view and filtered list (DV-12). |
| CP-10 | Audit trails are reviewed regularly. | A11 9 | History on every record and in its PDF; QA sees it at closure (DV-10). |
| CP-11 | CAPAs from self-inspections and complaints are implemented and followed up. The effectiveness of the CAPA procedure is checked at self-inspection. | SchM 6.1, 10.1, 2.3.3 | CAPA register with source *internal audit* or *complaint* and a free-text reference (DV-08). Complaint handling and audit management themselves are out of scope. |

## C. Considered and not applicable

| Clause | Reason |
|--------|--------|
| P11 11.30 (open systems) | Closed system: access is controlled by the manufacturer, including when hosted (P11 11.3(b)(4)). |
| P11 11.10(h) (device checks) | No device input. |
| P11 11.200(b), 11.300(c), (e) | No biometrics, tokens or cards. |
| A11 5 (data exchange) | No interfaces in v1 (standalone). |
| A11 15 (batch certification) | The system never certifies or releases batches. |
| C5 5.44 / SchM 18.4.6 (yield deviation) | Recorded as an ordinary deviation. |
| SchM 20.10 | Permits recording by other means; requires nothing of the product. |

## D. Dropped candidates (no binding clause breaks)

| Candidate | Why dropped |
|-----------|-------------|
| Reporter may not *close* their own deviation; owner may not verify their own CAPA (D-09) | No clause requires it. The independent check SchM 17.2.8 needs is placed at classification (DV-20: classifier is not the reporter); closure by the same QA user breaks nothing. |
| Blocking deviation closure until every CAPA is closed | No clause ties closure to CAPA completion. SchM 18.5.12 / 211.192 need the follow-up *recorded*; open CAPAs stay tracked (D-14, owner-confirmed). |
| Separate QA signature at classification | DV-02 is met by *Closed* (unplanned) and *Approved* (planned). The classification confirmation (DV-20) is a field, not a signature. |
| *Corrected* password signature on every correction | C4 4.9 / SchM 17.2.6 "signed and dated" is met by the authenticated, audit-trailed change with reason; Part 11 has no correction-signature rule. |
| Risk score / matrix | C1 1.4(xiv) and SchM 1.5(s) need an "appropriate level", not a score. |
| QA head approval, area-head acknowledgement | Not in any binding text (SchM 11.3.9(i) is about batch release). |
| Classification deadline; due-date extension approval | No clause sets one; target dates with overdue display and a reason for any date change are enough (D-15). |
| QA approval of target-date settings and lists | Covered by the site's change procedure (CP-07); changes are audited (DV-15). |
| Late-entry window | A deviation report is by nature after the event; both times are recorded (DV-13). |
| Email alerts | 11.300(d) is met by the persistent on-screen alert with named acknowledgement (DV-18). |
| A dedicated effectiveness check on every CAPA | SchM 2.2(b) allows monitoring through the trend and quality review instead, with a reason (DV-09). |
| Root-cause categories, recurrence flags, management-review page, change-control field | Owner declined (D-15); no binding clause requires them. |
| CSV export | P11 11.10(b) and A11 8.1 are met by the PDF and browser print (SA names PDF as acceptable). |

## E. Open points for the owner

None left from verification that need an owner decision. Every finding has a resolution
within the brief (see `04-register-verification.md`). Two of them change what you approved
in the requirements, so please glance at them:
1. **DV-20:** the person who reports a deviation cannot classify it. Another QA user does,
   and confirms product and batch. This is a narrow version of the dropped D-09, needed for
   SchM 17.2.8 "independently checked".
2. **DV-09:** a CAPA's effectiveness is either checked by a date or "monitored through the trend
   and quality review, because…". There is no plain "not needed", because SchM 1.5(s) says
   "shall be monitored".

Defaults (30-day target for all three classes, timeout 15 min, password expiry 90 days,
5 attempts) are product defaults, not regulatory numbers.
