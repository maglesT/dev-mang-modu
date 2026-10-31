# Deliverable (c): Minimum compliance register (draft 1)

Status: draft for owner approval · 2026-10-31. Verification results are in
`04-register-verification.md`.

## How rules got in (owner's test)

1. **Binding source required:** 21 CFR 211 and Part 11, EudraLex Vol 4 (Ch1, Ch4, Ch5,
   Annex 11), or Revised Schedule M Part I. FDA guidance and ICH Q10 may only relax or
   clarify a rule.
2. **Deviation relevance:** the clause governs recording, approving, investigating, acting on
   or closing a deviation, or the electronic records and signatures of those steps.
3. **Strictest requirement, least-strict implementation** that satisfies FDA, EU and
   Schedule M together.
4. **Removability:** the "Why required" column names the clause that breaks if the rule is
   dropped. Candidates that failed are in section D.

**Result: 22 product rules (DV-01 to DV-22) and 9 customer-procedure rules (CP-01 to CP-09).**

**Source keys:** **211**, **P11**: 21 CFR Parts 211 and 11 (eCFR 2026-10-28). **C1 / C4 /
C5**: EudraLex Vol 4 Part I, Chapters 1, 4 and 5. **A11**: Annex 11 (2011). **SchM**: Revised
Schedule M Part I (gazette sha256 9187…d271). Guidance: **SA**, FDA Part 11 Scope and
Application (2003); **DI**, FDA Data Integrity Q&A (2018); **Q10**, ICH Q10.

The machine-checked clause/phrase pairs for every rule are in `compliance/register-checks.json`.

## A. Product rules

### The deviation itself

| ID | Rule | Binding clauses | Why required (breaks if dropped) | Least-strict implementation | Test |
|----|------|-----------------|----------------------------------|-----------------------------|------|
| DV-01 | Every deviation is recorded: what happened, where, when, product and batch, immediate action. | 211.100(b); C1 1.8(vii); SchM 1.5(s), 3.1(6) | 211.100(b) (any deviation recorded and justified); SchM 1.5(s) (reported and recorded). | One *Report* form open to every user. Required: planned/unplanned, title, description, area, event time, product and batch (free text, "none" allowed), immediate action. The server assigns `DEV-YYYY-NNNN`, never reused. | Report refused without a required field; numbers are unique and sequential. |
| DV-02 | A deviation is approved in writing by a designated person, with QA/QC involved. A planned deviation is approved before it is carried out. | C5 5.15; SchM 18.2.2; 211.100(b) (justified) | SchM 18.2.2 and C5 5.15 (approved in writing by a designated/competent person). | Only QA can approve. Unplanned: the QA *Closed* signature (DV-10) is the written approval, so no extra signature is needed at classification. Planned: a QA *Approved* signature is required before the planned start date. Until then the deviation shows "Not approved: do not proceed". QA can instead *Reject* it, with a reason. | Non-QA cannot approve; a planned deviation shows "not approved" until QA signs. |
| DV-03 | The deviation's significance and impact are assessed, so the level of investigation fits the risk. | C1 1.4(xiv), 1.8(vii); SchM 1.5(s), 3.1(6) | C1 1.4(xiv) and SchM 1.5(s) (an *appropriate level* of root cause analysis); C1 1.8(vii) / SchM 3.1(6) apply to *significant* deviations, so significance must be decided. | QA sets minor / major / critical and writes a short impact assessment (product, batches, others possibly affected). No scoring or matrix (Q10 used only to keep it plain). | Investigation step not reachable before classification. |
| DV-04 | The investigation looks for the root cause at a suitable level. If it cannot be confirmed, the most likely root cause is identified. | C1 1.4(xiv), 1.8(vii); SchM 1.5(s), 3.1(6) | SchM 1.5(s) ("shall" identify the most likely root causes, stricter than C1 "should"). | Root cause text is required for every deviation, minor included. A tick "true root cause not confirmed; most likely cause stated" records the fallback. | Investigation cannot be signed without root cause text. |
| DV-05 | A conclusion of human error is justified, after making sure process, procedure or system causes were not overlooked. | C1 1.4(xiv) | C1 1.4(xiv) (the only clause on human error). | Ticking "human error" makes a justification field required. | Human error without justification refused. |
| DV-06 | The investigation extends to other batches of the same product and to other products that may be associated, whether or not the batch was distributed. | 211.192; SchM 18.5.12 | 211.192 (unconditional; SchM says "if necessary", so FDA is stricter and wins). | Before the investigation can be signed, the investigator either lists each other batch/product checked with an outcome (affected / not affected), or states why none could be associated. Listed batches feed the batch lookup (DV-11). | Signing refused when neither list nor statement is given. |
| DV-07 | A written record of the investigation includes the conclusions and the follow-up. | 211.192; SchM 18.5.12 | Both. | Conclusion is required to sign the investigation (*Investigation complete* signature by the investigator). Follow-up = the actions (DV-08) and the closure summary (DV-10). | Investigation cannot be signed without a conclusion. |
| DV-08 | Corrective and preventive actions are identified, taken and completed in a timely manner, and managed until done. | C1 1.4(xiv), 1.8(vii), 1.11; SchM 1.5(s), 2.3.3, 3.1(6) | SchM 2.3.3 (timely, effective, on-going management); SchM 1.5(s) ("shall be identified and taken"). | Action rows inside the deviation: corrective/preventive, description, owner, due date; the owner marks *Done* with a note; QA marks *Verified*. Overdue is shown everywhere. QA may record "no action needed, because…" for a **minor** deviation only. Due-date changes need a reason (kept in history). | Closing refused with an unverified action; overdue action shows on lists. |
| DV-09 | The effectiveness of corrective and preventive actions is monitored. | SchM 1.5(s); C1 1.4(xiv) | SchM 1.5(s) ("shall be monitored"). | For each action QA records *Effectiveness check: needed by <date>* or *not needed, because…* (Q10 and C1 "in line with QRM" allow risk-based checks). A needed check is recorded later as effective / not effective with a note. Open checks stay on the lists after closure. | Action cannot be verified without an effectiveness decision; open check listed after closure. |
| DV-10 | The quality unit reviews the investigation and approves the closure. | 211.22(a); 211.192; C5 5.15; SchM 18.2.2 | 211.22(a) (QA's authority to make sure errors were fully investigated); C5 5.15 / SchM 18.2.2 (written approval). | Only QA can close, with a closure summary and a *Closed* e-signature, and only when the investigation is signed and every action is verified (DV-08). QA *Reopen* (with reason) moves it back to Investigation. | Non-QA cannot close; close refused while an action is open. |
| DV-11 | Deviations concerning a batch are available to whoever assesses that batch for release. | 211.192; C1 1.9(vi); SchM 19.4(f) | C1 1.9(vi) / SchM 19.4(f) (product assessment includes an assessment of deviations); 211.192 (records reviewed before release). | "Affects batch X" lookup: matches the deviation's own batch and every batch listed under DV-06, with status. Open ones are marked. The release decision itself stays outside the system (CP-05). | Lookup finds a batch listed only as an "other batch"; open ones are flagged. |
| DV-12 | Deviation data can be used for the at-least-annual review of investigations and the product quality review. | 211.180(e)(2); SchM 2.3.2(c), (d); C1 1.10(iv) | 211.180(e)(2) (review of investigations under 211.192); SchM 2.3.2(d). | List filtered by product (free-text match) and date range, plus counts by month split by area, type or classification (one table, one chart). Printing uses the browser. | Counts match the records for a date range and product. |
| DV-13 | Records are made at the time the action is taken. | 211.100(b); C4 4.8; SchM 17.2.7 | All. | The server stamps every save and signature. The user enters "when it happened" for the event itself, and both times are shown. No late-entry window: the report time *is* the record time. | Saved time is server time; future event time refused. |

### Electronic records and signatures

| ID | Rule | Binding clauses | Why required | Least-strict implementation | Test |
|----|------|-----------------|--------------|-----------------------------|------|
| DV-14 | Alterations keep the original readable, are signed and dated, and give a reason. Nothing is deleted. | C4 4.9; SchM 17.2.6; P11 11.10(e) | C4 4.9 / SchM 17.2.6. | Sections are saved as versions. A correction needs a reason and a *Corrected* e-signature. A correction after a signature marks that signature *superseded*, so the step must be signed again. Attachments can only be *withdrawn*, with a reason. The app's DB user has no UPDATE/DELETE on record, signature and audit tables. (Logbook LB-17, re-checked.) | Old value visible; DB refuses delete. |
| DV-15 | A computer-generated, time-stamped audit trail records every creation and change (who, when, old and new value). It cannot be altered and is kept as long as the record. | P11 11.10(e); SchM 17.2.8, 20.4; A11 9 | SchM 20.4 (record of any data change, previous entry, person, time), which is stricter than SA enforcement discretion on 11.10(e). | One audit table written by the server in the same transaction, covering deviations, actions, signatures, users, roles, lists and settings. History is shown on the deviation page and in the PDF. (Logbook LB-18.) | Every action writes an audit row; the table is not writable by the app. |
| DV-16 | Signatures show printed name, date/time and meaning, on screen and in print, and are permanently linked to their record. | P11 11.50, 11.70; A11 14 | P11 11.50, 11.70; A11 14. | Signature stores full name, server time, meaning (*Approved, Rejected, Investigation complete, Verified, Closed, Reopened, Corrected*), the record version and a content hash. Shown as IST with the zone label. (Logbook LB-19.) | Fields shown in view/PDF; altered content fails the hash check. |
| DV-17 | E-signatures are unique to one person, never reused or reassigned, and use two components (ID + password). | P11 11.100(a), 11.200(a), 11.300(a), (b) | All. | ID + password at every signing. User IDs are never renamed or reused. Admins never see or set a usable password (temporary password changed at first login); password expiry (default 90 days). (Logbook LB-20.) | Wrong password or other user's ID fails; reused ID refused. |
| DV-18 | Only authorised people use the system, with authority checks per action. Access changes are recorded. Attempted misuse is reported at once. | P11 11.10(d), (g), 11.300(d); 211.68(b); A11 12.1, 12.3; SchM 17.2.8, 20.4 | All. | Named accounts; three fixed roles checked on the server for every action; Admin cannot report, act or sign; session timeout 15 min. 5 failed logins lock the account and raise an on-screen alert for logged-in Admin and QA users, plus an audit row (no email). (Logbook LB-21.) | Each role refused outside its rights; lockout raises the alert. |
| DV-19 | Steps happen in their permitted order. | P11 11.10(f) | 11.10(f). | Server checks: classify before investigate; planned deviation approved before it can proceed; investigation signed before closure; actions verified before closure; Done before Verified. | One test per check. |
| DV-20 | Critical manually entered data get an additional accuracy check, by a second person or by the system. Input is checked. | SchM 17.2.8, 20.6; A11 6; 211.68(b) | SchM 20.6 / A11 6. | System checks on every field (required fields, dates in order, event time not in future, due date not in the past at entry). The second-person check is QA's review of the whole record at closure (DV-10). No extra double entry. | Invalid input refused; closure only by QA. |
| DV-21 | Accurate, complete readable copies are available, including the audit trail. | P11 11.10(b); 211.180(c); A11 8.1 | P11 11.10(b); A11 8.1. | One PDF per deviation: every section with all versions marked, signatures, actions, attachment list and history. Attachments are downloadable as stored. Lists and trends print from the browser. | PDF includes versions, signatures and history. |
| DV-22 | Records are protected and retrievable for the whole retention period, with regular backups, a check of stored data, and no omissions or silent loss. | P11 11.10(c); 211.68(b), 211.180(a); C4 4.10; A11 7.1, 7.2; SchM 17.2.7, 20.4, 20.9 | All. | Nothing deleted (meets every retention period: 1 year past expiry, SchM 17.2.7 / 211.180(a)). Each save is all-or-nothing and confirmed on screen. Daily backup kept 1 year (default) with a restore script. A nightly integrity check re-reads records and verifies signature hashes. (Logbook LB-23, LB-26.) | No delete path; tampered row detected; restore script passes in CI. |

## B. Customer procedures (required; the product supports them but cannot do them)

| ID | Rule | Binding clauses | Product support |
|----|------|-----------------|-----------------|
| CP-01 | Validate the system for its intended use. | P11 11.10(a); A11 1, 4; SchM 20.1–20.3 | Rule-to-test traceability list from test names, plus the CI test report. |
| CP-02 | Qualified, trained people with defined responsibilities. | P11 11.10(i); A11 2 | — |
| CP-03 | Policies: signature accountability, identity check before issuing accounts, certification to FDA, periodic access review, periodic restore test, who watches misuse alerts. | P11 11.10(j), 11.100(b), (c), 11.300(b); A11 7.2, 12.3 | Signature declaration text; access-list report; restore script. |
| CP-04 | A written, approved procedure for handling deviations (classification criteria, who investigates, target times). | 211.100(a), 211.22(d); C4 4.29; SchM 2.3.3, 18.2.2 | Target-date settings and lists match the SOP. |
| CP-05 | The batch release decision takes open and closed deviations into account. | C1 1.9(vi); SchM 19.4(f); 211.192 | "Affects batch X" lookup (DV-11). |
| CP-06 | Supplier agreement and assessment. | A11 3; P11 11.30 if hosted | Supplier documentation pack. |
| CP-07 | Change control, incident management and periodic evaluation of the system. | A11 10, 11, 13; P11 11.10(k); SchM 20.7, 20.8 | Release notes per version; an audit row when the software version changes. |
| CP-08 | Business continuity: controlled paper deviation forms when the system is down, then entered with the paper form number. | A11 16; SchM 20.10 | The event time is entered separately from the report time (DV-13). |
| CP-09 | Management and product quality reviews that use deviation and CAPA data. | 211.180(e); C1 1.6, 1.10, 1.11; SchM 1.6, 2.3 | Trend view and filtered list (DV-12). |

## C. Considered and not applicable

| Clause | Reason |
|--------|--------|
| P11 11.30 (open systems) | Closed system (on-premise, or hosted under CP-06). |
| P11 11.10(h) (device checks) | No device input. |
| P11 11.200(b), 11.300(c), (e) | No biometrics, tokens or cards. |
| A11 5 (data exchange) | No interfaces in v1 (standalone, owner default). |
| A11 15 (batch certification) | The system never certifies or releases batches. |
| C5 5.44 / SchM 18.4.6 (yield deviation) | Recorded as an ordinary deviation; no separate rule. |

## D. Dropped candidates (no binding clause breaks)

| Candidate | Why dropped |
|-----------|-------------|
| Reporter may not close their own deviation; nobody verifies their own action (D-09) | No clause requires independence from the reporter. 211.22(a) and C5 5.15 need QA approval, which DV-10 gives. Dropped by the removability test. |
| Separate QA signature at classification | DV-02 is met by the *Closed* signature for unplanned deviations; one signature fewer. |
| Risk score / matrix for classification | C1 1.4(xiv) and SchM 1.5(s) need an "appropriate level", not a score. |
| QA head approval of critical deviations, area-head acknowledgement | Not in any binding text. |
| Classification deadline (e.g. within 1 working day) | No clause sets one; target closure plus overdue display meets "timely" (SchM 2.3.3). |
| QA approval of target-date settings and lists | Not controlled documents; changes are audited (DV-15) and the SOP (CP-04) states the values. |
| Late-entry window and reason (logbook LB-04) | A deviation report is by nature after the event; the event time and report time are both recorded (DV-13). |
| Email alerts and escalation | 11.300(d) is met on screen (DV-18). |
| Effectiveness check on every action | SchM 1.5(s) requires monitoring, and the C1 / Q10 risk-based approach allows "not needed, because…" (DV-09). |
| CSV export | P11 11.10(b) and A11 8.1 are met by the PDF and browser print. |

## E. Open points for the owner

1. **DV-09 effectiveness checks:** SchM 1.5(s) says effectiveness "shall be monitored". I read
   "not needed, because…" as allowed (risk-based, C1 1.4(xiv) "in line with QRM"). The stricter
   reading, a check for every action, would add work for every minor fix. Please confirm the
   lighter reading.
2. **DV-08 "no action" only for minor:** my reading of SchM 1.5(s) / C1 1.8(vii). Major and critical
   deviations always get at least one action. Please confirm.
3. Defaults (30-day target closure for all three classes, timeout 15 min, password expiry 90 days,
   5 attempts) are product defaults, not regulatory numbers.
