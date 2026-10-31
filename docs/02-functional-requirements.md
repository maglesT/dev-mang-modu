# Deviation and CAPA system: functional requirements, deliverable (b) (draft 2)

Status: draft for owner approval · 2026-10-31. Draft 2 adds the CAPA register (D-13) and aligns with register draft 2.
Rule IDs (DV-xx, CP-xx) refer to `03-compliance-register.md`.

## 1. Purpose and scope

A deviation management system for one Indian export pharma plant. Anyone records a
deviation; QA classifies it; the investigation finds the root cause and checks other
batches; corrective and preventive actions (CAPAs) are raised from it; QA closes it with an
e-signature. CAPAs are small records of their own, so the same list is the site's **CAPA
register**, also for CAPAs from internal audits, complaints and other sources (D-13). One web app in the browser (desktop PCs, tablets through the browser).

**In scope**
- **One site per installation.** The site name and code appear on screens and the PDF.
- **Deviation record:** report, classification, investigation, closure, in one record that moves through fixed steps.
- **CAPA record:** source (deviation, internal audit, complaint, other), corrective or preventive, owner, due date, done, QA verification, effectiveness check, QA closure. Raised from a deviation or entered directly.
- **Planned deviations:** the same record, approved by QA before the planned change is carried out.
- **Lists:** open, overdue, awaiting me, "affects batch X", and the CAPA list. A simple trend view.
- **Records:** audit trail, fixed roles, e-signatures, corrections with reason, attachments, PDF of one deviation (with its CAPAs) and of one CAPA, nightly integrity check, daily backups.

**Out of scope (possible later extensions)**
- complaint handling, audit management and change control (a CAPA from those sources only carries a free-text reference);
- links to Batchwright or the logbook. Batch numbers are free text, and both systems already store a deviation number, so a lookup can come later;
- OOS lab investigations, recalls, product quality review documents;
- integration with the audit-checklist product (its findings are typed in as a reference in v1);
- configurable workflows, form designers, risk matrices or scoring, fishbone/5-why editors;
- email/SMTP, escalations, dashboards and report builders, document control, several sites;
- native mobile app, offline mode, multi-language UI.

## 2. Roles (fixed, no role editor)

| Role | Can do |
|------|--------|
| **User** (everyone with an account) | Report a deviation. When assigned: write the investigation, carry out their CAPAs and mark them done. Correct their own entries. |
| **QA** | Everything a User can do, plus: classify, assign the investigator, approve a planned deviation, extend a target or due date (with reason), raise CAPAs (from a deviation or directly), verify them, decide and record effectiveness checks, close CAPAs and deviations, reopen. View the audit trail. |
| **Admin** | Users and role assignment; the area and deviation-type lists; target-date settings. **No** deviation entries and **no** signatures. |

A user may hold several roles. There is no rule that the reporter cannot close or that an
CAPA owner cannot verify their own CAPA: no binding clause requires it (D-09). The one exception is
classification: the reporter cannot classify their own deviation, so product and batch get an
independent check (DV-20).

## 3. The deviation record

One record, one page, four sections filled in order, with its CAPAs listed in between. The page always shows the **current
step, who must act next, and the due date** at the top.

| Step / section | Who | Fields (required unless marked optional) |
|----------------|-----|-------------------------------------------|
| **1. Report** | any User | Planned or unplanned; title; what happened; where (area from a list; equipment as free text, optional); when it happened (date/time, may be earlier than now); product and batch number(s), free text, "none" allowed (e.g. a facility event); initial impact assessment (product quality, patient safety, other batches: yes / no / not known, and a short note; D-34); action taken (immediate action) and when; for a **planned** deviation, the reason for it; attachments (optional). The server assigns the number (`DEV-2026-0001`, never reused) and stores the reporter and report time. |
| **2. Classify** | QA | Minor / major / critical; deviation type (from a short list); impact assessment (product, batches affected, other batches or products possibly affected) as text; investigator (a user); tick "product and batch checked" (DV-20). The classifier cannot be the person who reported it. Sets the target closure date from the classification. For a **planned** deviation: QA approves before it is carried out (*Approved* e-signature) or rejects it. |
| **3. Investigate** | investigator | Tools, all required (D-33, D-35, D-36): Is / Is Not; 6M fishbone with evidence and ruled in / out per M; 5 Whys with evidence; root-cause category; barrier analysis; FMEA; KT checklist for lab / OOS types; fault tree when critical. Saved as drafts while investigating. Root cause (plain text). Tick "root cause could not be confirmed; most likely cause stated" where it applies. Tick "human error", with a justification that system or procedure causes were ruled out. **Other batches and products:** list each one checked with its outcome (affected / not affected), or state why no other batch or product could be involved. Conclusion. The investigator signs it *Investigation complete*. |
| **CAPAs** | QA | QA raises one or more CAPAs from the deviation (section 3a). Each is its own record linked to the deviation, and the deviation page lists them with status and due date. A major or critical deviation needs at least one. For a minor one QA may record "no CAPA: the immediate action was appropriate, because…". |
| **4. Close** | QA | Closure summary; batch disposition notes (text, e.g. "batch B123 may be released; see QA decision"); *Closed* e-signature. Allowed when the investigation is signed and the CAPAs are **raised** (each with owner and due date), or "no CAPA" is recorded for a minor deviation. The closing step shows the deviation's history. Open CAPAs do **not** block closure: they stay on the CAPA list until closed, and the deviation shows "Closed · 2 CAPAs open" (D-14). |

**Status shown on lists:** Awaiting classification · Awaiting approval (planned) ·
Investigation · Awaiting closure · Closed · (Rejected, planned only). Open CAPAs are shown
next to the status.
A QA *Reopen* (reason and e-signature) opens a closed deviation again for correction; it is closed again with a new signature.

## 3a. The CAPA record

One small record, one page. Number `CAPA-YYYY-NNNN`, never reused.

| Field / step | Who | Content |
|--------------|-----|---------|
| **Raise** | QA | Source: *deviation* (linked, chosen from the deviation page), *internal audit* (free-text audit and finding reference), *complaint* (free-text reference) or *other* (free text). Corrective or preventive; what to do; owner (a user); due date; product/batch (optional, free text). |
| **Done** | owner | Note of what was done (attachments optional). |
| **Verify** | QA | *Verified* e-signature that it was done. At the same time QA chooses the effectiveness monitoring: a **dedicated check** by a date, or **"monitored through the trend and quality review, because…"**; in the second case verifying also closes the CAPA (DV-09). |
| **Effectiveness check** (if needed) | QA | Result effective / not effective, with a note. "Not effective" asks QA to raise a follow-up CAPA. QA then closes the CAPA with a *Closed* e-signature. |

**CAPA status:** Open · Done (awaiting QA) · Effectiveness check due · Closed. Overdue means
past its due date (or past its check date) and not closed.

**Timelines (defaults, set by Admin):**
- Target closure is the report date plus 30 days for each classification (minor, major, critical). Admin can change the three numbers.
- QA may extend the target closure date, a CAPA due date or a check date with a reason. The old date stays in the history.
- *Overdue* shows in red on every list and page.
- *Awaiting classification* and *Awaiting approval* are always at the top of the QA home.

## 4. Screens (six, four of them the same as draft 1)

1. **Home:** big *Report a deviation* button. "Waiting for me" (my investigations, my CAPAs; for QA, everything awaiting QA, including effectiveness checks), each with its due date, overdue items first. Tabs: Open · Overdue · All. A search box takes a batch number, a deviation number or a word.
2. **Deviation page:** the four sections above and its CAPAs, the next action as the one highlighted button, history (audit trail) at the bottom, *Print PDF*.
3. **CAPA list:** filter by source, status and overdue; *New CAPA* button (QA) for audit, complaint or other sources. It is the site's CAPA register.
4. **CAPA page:** the fields above, the next action highlighted, history, *Print PDF*.
5. **Batch & trends:** "affects batch X" (every deviation whose own batch or listed other batch matches, with status, so a release decision can see open deviations). Trend view: counts by month, as a table and one bar chart, split by area, type or classification, for a chosen date range and product.
6. **Admin:** users and roles, area list, deviation-type list, target-date settings, site name.

The trend view also counts CAPAs by source and status.

## 5. Main flows

1. **Report:** anyone opens *Report a deviation*, fills in one short form and saves. They get a number at once. QA sees it under *Awaiting classification*.
2. **Classify:** QA sets minor/major/critical, type, impact and investigator. The target date appears. The investigator sees it under *Waiting for me*.
3. **Investigate:** the investigator writes the root cause, checks other batches, writes the conclusion and signs.
4. **CAPAs:** QA raises CAPAs from the deviation with owners and due dates. Owners mark them done; QA verifies and decides on the effectiveness check; QA records the check and closes.
5. **Close:** QA writes the closure summary and signs *Closed*. Open CAPAs stay on the CAPA list.
5a. **CAPA from an audit, complaint or other source:** QA clicks *New CAPA*, chooses the source, types the reference, and the CAPA follows the same steps.
6. **Planned deviation:** reported before the event → QA approves (signature) → carried out → the same investigate, CAPA and close steps. Investigation may be short ("carried out as approved").
7. **Correct an entry:** edit a saved section or CAPA with a reason (no password needed; the audit trail records who and when). The old value stays visible in the history. A correction after a signature makes that signature *superseded*, and the step must be signed again. Nothing is deleted.
8. **Batch check:** anyone types a batch number and sees every deviation that names it, with status. Open ones are marked.
9. **Annual review:** QA filters by product and year and prints or exports the list and trend (211.180(e), SchM 2.3.2).

## 6. Cross-cutting (reused from the logbook after re-check, see D-06)

- **Accounts:** unique named accounts; IDs never reused; no shared logins.
- **Sessions and passwords:** session timeout 15 min; password rules and expiry as in the logbook.
- **Lockout:** after 5 failed logins or failed signing attempts the account locks; an on-screen alert stays for every Admin and QA user until a named person acknowledges it; an audit entry is written. An Admin cannot change their own roles.
- **Time:** server time on every save, stored in UTC and shown in IST with the zone label. "When it happened" is entered by the user and can be earlier.
- **E-signature:** user ID and password at each signing. Shows name, time and meaning; linked to the exact record version.
- **Audit trail:** one append-only audit trail written by the server: who, when, what changed, old and new values, and the reason.
- **Attachments:** PDF or image files, up to 10 MB each, never deleted; a correction can mark an attachment *withdrawn*, with a reason.
- **Integrity and backups:** nightly integrity check; daily backup with a SHA-256, copied to an off-host location, kept 1 year by default; restore check script.
- **Alerts:** on screen only (counts on the Home tabs and a badge). No email.

## 7. Non-functional

- **Platform:** browser app; usable on a 10" tablet (large touch targets).
- **Hosting:** on-premise or private cloud via Docker, as the logbook.
- **Performance:** 200 concurrent users; a save in < 1 s; batch lookup in < 1 s with 50,000 deviations.
- **Validation support:** rule-to-test traceability list generated from test names, plus the CI test report.

## Simplicity review

**Considered and dropped**
- QA head and area head roles: no binding clause needs a second QA level or an area approval. QA (the quality unit, 211.22; the "designated/competent person", SchM 18.2.2, EU 5.15) is enough (D-08).
- Risk matrix or score for classification: three plain levels meet every clause; no text requires scoring.
- Root-cause tool suite (5-why): plain text meets 1.5(s) / 1.4(xiv). (Fishbone added at the owner's request, D-26.)
- CAPA workflow engine, CAPA risk scoring, CAPA approval of the plan before work starts: one fixed sequence (raise, done, verify, check, close) meets SchM 1.5(s), 2.3.3 and C1 1.4(xiv).
- Complaint, audit and change-control modules: out of scope; a free-text source reference is enough for v1.
- Blocking deviation closure until every CAPA is closed: no clause requires it, and open CAPAs stay tracked (D-14).
- Classification due date / SLA timers per step: one target closure date plus CAPA due dates is enough to show "timely" (SchM 2.3.3).
- Email, escalation chains, reminders: on-screen lists only (owner principle).
- CSV export and report builder: one PDF per deviation (printed copies, A11 8.1; inspection, 211.180(c)), plus browser print of lists and trends.
- Batch or product master data: free text (owner default); no need for a product list.
- Area-head acknowledgement of immediate action: not required by any clause.
- "Reporter cannot close / owner cannot verify own CAPA": no binding clause requires it (D-09).
- *Corrected* password signature: an audit-trailed change with a reason is enough (DV-14).
- Extension approval workflow: QA extends with a reason; that is enough.

**Kept that someone could call extra**
- Reporter cannot classify their own deviation, and QA confirms product and batch: SchM 17.2.8 (critical entries "independently checked"), SchM 20.6 (DV-20).
- Planned deviations: SchM 18.2.2 and EU 5.15 require written approval of a deviation by a designated person. For a planned deviation that means approval *before* it happens.
- "Most likely cause" tick and human-error justification: SchM 1.5(s) ("most likely root causes shall be identified") and EU 1.4(xiv) (justify human error).
- Other-batches list: 211.192 (the investigation extends to other batches and products) and SchM 18.5.12.
- **CAPA as its own small record with a source (D-13, owner decision, confirmed 31 Oct):** the core CAPA need once audits and complaints feed CAPAs too; one list serves as the site's CAPA register (SchM 2.3.3 on-going management of CAPAs; C1 1.11). Kept small: no workflow engine, no scoring.
- Effectiveness monitoring per CAPA: SchM 1.5(s) ("shall be monitored"). "Monitored through the trend and quality review, because…" keeps it light (SchM 2.2(b)).
- Target dates and overdue: SchM 2.3.3 (CAPA completed in a timely manner) and the core need to see due dates at a glance.
- Trend view: 211.180(e)(2) annual review of investigations, SchM 2.3.2(d), EU 1.10(iv). One table and one chart; no dashboard.
- Attachments: core need (photos, printouts as evidence); A11 8.1 requires them to be printable with the record.
- Reopen: needed so a closed record is never edited in place (A11 9, P11 11.10(e) audit trail).
- Fishbone (six categories, optional) in the investigation: owner request (D-26).
- "Things to look at" on the deviation page: rule-based repeat flags and similar earlier cases with their root causes and CAPAs (owner request, D-27, D-28). Advice only.
- AI-suggested possible causes (Gemini) in very simple language, with "how to check" (owner request, D-27, D-29). Advice only; audited; off without a key.
- Data collection (Measure): uploads, and "Fetch related data" from Batchwright and the Logbook, read-only, kept as checksummed copies with plain-words findings (D-37, DV-23).
- Unusual months on the trend (one c-chart rule, explained on screen; D-30). Advice only.
- The deviation page is organised as DMAIC: Define, Measure, Analyze, Improve, Control, with a progress bar (owner request, D-31). The same steps; a view only.
- Deviation-type and area lists: needed for the trend view (counts by area and type); a free-text field cannot be counted.
