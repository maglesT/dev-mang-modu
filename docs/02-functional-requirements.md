# Deliverable (b): Functional requirements (draft 1)

Status: draft for owner approval · 2026-10-31.
Rule IDs (DV-xx, CP-xx) refer to `03-compliance-register.md`.

## 1. Purpose and scope

A deviation management system for one Indian export pharma plant. Anyone records a
deviation; QA classifies it; the investigation finds the root cause and checks other
batches; corrective and preventive actions are tracked inside the deviation; QA closes it
with an e-signature. One web app in the browser (desktop PCs, tablets through the browser).

**In scope**
- **One site per installation.** The site name and code appear on screens and the PDF.
- **Deviation record:** report, classification, investigation, actions (CAPA), closure, in one record that moves through fixed steps.
- **Planned deviations:** the same record, approved by QA before the planned change is carried out.
- **Lists:** open, overdue, awaiting me, and "affects batch X". A simple trend view.
- **Records:** audit trail, fixed roles, e-signatures, corrections with reason, attachments, PDF of one deviation, nightly integrity check, daily backups.

**Out of scope (possible later extensions)**
- a full CAPA system fed by audits, complaints and other sources (separate later product);
- links to Batchwright or the logbook. Batch numbers are free text, and both systems already store a deviation number, so a lookup can come later;
- change control, complaints, OOS lab investigations, recalls, product quality review documents;
- configurable workflows, form designers, risk matrices or scoring, fishbone/5-why editors;
- email/SMTP, escalations, dashboards and report builders, document control, several sites;
- native mobile app, offline mode, multi-language UI.

## 2. Roles (fixed, no role editor)

| Role | Can do |
|------|--------|
| **User** (everyone with an account) | Report a deviation. When assigned: write the investigation, complete their actions. Correct their own entries. |
| **QA** | Everything a User can do, plus: classify, assign the investigator, approve a planned deviation, extend a target date (with reason), verify actions, decide on effectiveness checks, close or reopen a deviation. View the audit trail. |
| **Admin** | Users and role assignment; the area and deviation-type lists; target-date settings. **No** deviation entries and **no** signatures. |

A user may hold several roles. There is no rule that the reporter cannot close or that an
owner cannot verify their own action: no binding clause requires it (D-09, register section D).

## 3. The deviation record

One record, one page, five sections filled in order. The page always shows the **current
step, who must act next, and the due date** at the top.

| Step / section | Who | Fields (required unless marked optional) |
|----------------|-----|-------------------------------------------|
| **1. Report** | any User | Planned or unplanned; title; what happened; where (area from a list; equipment as free text, optional); when it happened (date/time, may be earlier than now); product and batch number(s), free text, "none" allowed (e.g. a facility event); immediate action taken; attachments (optional). The server assigns the number (`DEV-2026-0001`, never reused) and stores the reporter and report time. |
| **2. Classify** | QA | Minor / major / critical; deviation type (from a short list); impact assessment (product, batches affected, other batches or products possibly affected) as text; investigator (a user). Sets the target closure date from the classification. For a **planned** deviation: QA approves before it is carried out (*Approved* e-signature) or rejects it. |
| **3. Investigate** | investigator | Root cause (plain text). Tick "root cause could not be confirmed; most likely cause stated" where it applies. Tick "human error", with a justification that system or procedure causes were ruled out. **Other batches and products:** list each one checked with its outcome (affected / not affected), or state why no other batch or product could be involved. Conclusion. The investigator signs it *Investigation complete*. |
| **4. Actions (CAPA)** | QA adds, owners act | Zero or more rows: corrective or preventive; what to do; owner (user); due date. The owner marks it *Done* with a note. QA marks it *Verified*. For each action QA sets *Effectiveness check*: "needed, by date" or "not needed, because…". A check is recorded later as effective / not effective with a note; "not effective" prompts a new action. If there are no actions, QA states why (allowed only for minor deviations). |
| **5. Close** | QA | Closure summary; batch disposition notes (text, e.g. "batch B123 may be released; see QA decision"); *Closed* e-signature. Allowed only when the investigation is complete and every action is *Verified*. Open effectiveness checks may stay open after closure; they stay on the lists until done. |

**Status shown on lists:** Awaiting classification · Awaiting approval (planned) ·
Investigation · Actions open · Awaiting closure · Closed · (Rejected, planned only).
A QA *Reopen* (with reason) moves a closed deviation back to Investigation.

**Timelines (defaults, set by Admin):**
- Target closure is the report date plus 30 days for each classification (minor, major, critical). Admin can change the three numbers.
- QA may extend the target closure date or an action due date with a reason. The old date stays in the history.
- *Overdue* shows in red on every list and page.
- *Awaiting classification* and *Awaiting approval* are always at the top of the QA home.

## 4. Screens (four)

1. **Home:** big *Report a deviation* button. "Waiting for me" (my investigations, my actions, my effectiveness checks; for QA, everything awaiting QA), each with its due date, overdue items first. Tabs: Open · Overdue · All. A search box takes a batch number, a deviation number or a word.
2. **Deviation page:** the five sections above, the next action as the one highlighted button, history (audit trail) at the bottom, *Print PDF*.
3. **Batch & trends:** "affects batch X" (every deviation whose own batch or listed other batch matches, with status, so a release decision can see open deviations). Trend view: counts by month, as a table and one bar chart, split by area, type or classification, for a chosen date range and product.
4. **Admin:** users and roles, area list, deviation-type list, target-date settings, site name.

## 5. Main flows

1. **Report:** anyone opens *Report a deviation*, fills in one short form and saves. They get a number at once. QA sees it under *Awaiting classification*.
2. **Classify:** QA sets minor/major/critical, type, impact and investigator. The target date appears. The investigator sees it under *Waiting for me*.
3. **Investigate:** the investigator writes the root cause, checks other batches, writes the conclusion and signs.
4. **Actions:** QA adds actions with owners and due dates. Owners mark them done, QA verifies, and QA decides on effectiveness checks.
5. **Close:** QA writes the closure summary and signs *Closed*. Remaining effectiveness checks stay on the lists.
6. **Planned deviation:** reported before the event → QA approves (signature) → carried out → the same investigate, actions and close steps. Investigation may be short ("carried out as approved").
7. **Correct an entry:** edit a saved section with a reason and an e-signature. The old value stays visible in the history. A correction after a signature makes that signature *superseded*, and the step must be signed again. Nothing is deleted.
8. **Batch check:** anyone types a batch number and sees every deviation that names it, with status. Open ones are marked.
9. **Annual review:** QA filters by product and year and prints or exports the list and trend (211.180(e), SchM 2.3.2).

## 6. Cross-cutting (reused from the logbook after re-check, see D-06)

- **Accounts:** unique named accounts; IDs never reused; no shared logins.
- **Sessions and passwords:** session timeout 15 min; password rules and expiry as in the logbook.
- **Lockout:** after 5 failed logins the account locks; an on-screen alert goes to Admin and QA; an audit entry is written.
- **Time:** server time on every save, stored in UTC and shown in IST with the zone label. "When it happened" is entered by the user and can be earlier.
- **E-signature:** user ID and password at each signing. Shows name, time and meaning; linked to the exact record version.
- **Audit trail:** one append-only audit trail written by the server: who, when, what changed, old and new values, and the reason.
- **Attachments:** PDF or image files, up to 10 MB each, never deleted; a correction can mark an attachment *withdrawn*, with a reason.
- **Integrity and backups:** nightly integrity check; daily backup kept 1 year by default; restore script.
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
- Root-cause tool suite (fishbone, 5-why): plain text meets 1.5(s) / 1.4(xiv).
- Separate CAPA module and CAPA numbers: actions live inside the deviation (owner default).
- Classification due date / SLA timers per step: one target closure date plus action due dates is enough to show "timely" (SchM 2.3.3).
- Email, escalation chains, reminders: on-screen lists only (owner principle).
- CSV export and report builder: one PDF per deviation (printed copies, A11 8.1; inspection, 211.180(c)), plus browser print of lists and trends.
- Batch or product master data: free text (owner default); no need for a product list.
- Area-head acknowledgement of immediate action: not required by any clause.
- "Reporter cannot close / owner cannot verify own action": no binding clause requires independence from the reporter; QA approval (DV-10) is enough (D-09).
- Extension approval workflow: QA extends with a reason; that is enough.

**Kept that someone could call extra**
- Planned deviations: SchM 18.2.2 and EU 5.15 require written approval of a deviation by a designated person. For a planned deviation that means approval *before* it happens.
- "Most likely cause" tick and human-error justification: SchM 1.5(s) ("most likely root causes shall be identified") and EU 1.4(xiv) (justify human error).
- Other-batches list: 211.192 (the investigation extends to other batches and products) and SchM 18.5.12.
- Effectiveness check per action: SchM 1.5(s) (CAPA effectiveness shall be monitored), EU 1.4(xiv). "Not needed, because…" keeps it light.
- Target dates and overdue: SchM 2.3.3 (CAPA completed in a timely manner) and the core need to see due dates at a glance.
- Trend view: 211.180(e)(2) annual review of investigations, SchM 2.3.2(d), EU 1.10(iv). One table and one chart; no dashboard.
- Attachments: core need (photos, printouts as evidence); A11 8.1 requires them to be printable with the record.
- Reopen: needed so a closed record is never edited in place (A11 9, P11 11.10(e) audit trail).
- Deviation-type and area lists: needed for the trend view (counts by area and type); a free-text field cannot be counted.
