# Deliverable (a): Source documents

Status: draft for owner approval · 2026-10-31

These are the official texts the compliance register will cite. Only clauses that a
deviation system needs are used. The official files are kept **out of git** (`sources/`
is git-ignored). The repo keeps only title, version, URL, sha256 and short paraphrases.
The machine-readable inventory (`compliance/sources.yaml`) comes with deliverable (c).

## Inventory

| # | Document | Binding? | Version / in force | Official URL | sha256 (file as fetched 2026-10-31) | Status |
|---|----------|----------|--------------------|--------------|-------------------------------------|--------|
| 1 | 21 CFR Part 211, cGMP for finished pharmaceuticals (eCFR) | Binding | eCFR point-in-time 2026-10-28 | https://www.ecfr.gov/api/versioner/v1/full/2026-10-28/title-21.xml?part=211 | `ecd9f8ba39e59c7713be98c293f1da4b125a68706d32ce4c77a0b579797423e3` | Have |
| 2 | 21 CFR Part 11, electronic records and signatures (eCFR) | Binding | eCFR point-in-time 2026-10-28 | https://www.ecfr.gov/api/versioner/v1/full/2026-10-28/title-21.xml?part=11 | `7fff122daf0a667920b359ce857373b6cf503e36c5b6d96b5537bac925ae9197` | Have |
| 3 | EudraLex Vol 4 Part I, Chapter 1, Pharmaceutical Quality System (rev 3) | Binding (EU GMP) | In force 31 Jan 2013 | https://health.ec.europa.eu/system/files/2016-11/vol4-chap1_2013-01_en_0.pdf | `11e87c3246abeaac008615f5e9ef8249eaf6c32685d180cb8d1d61a95ae00105` | Have (fetched myself; no need to ask) |
| 4 | EudraLex Vol 4 Part I, Chapter 4, Documentation | Binding | In force 30 Jun 2011 | https://health.ec.europa.eu/system/files/2016-11/chapter4_01-2011_en_0.pdf | `2a5cc412db411d5b2728706a138ae68986c36ea3390e645a305d39c839fdd50a` | Have |
| 5 | EudraLex Vol 4 Part I, Chapter 5, Production | Binding | In force 1 Mar 2015 | https://health.ec.europa.eu/system/files/2016-11/chapter_5_0.pdf | `c14625cc4e8b071f1822075641b8d5d0daed24d2a5919dc0b0838db485f623ae` | Have |
| 6 | EudraLex Vol 4 Annex 11, Computerised Systems | Binding | In force 30 Jun 2011 | https://health.ec.europa.eu/system/files/2016-11/annex11_01-2011_en_0.pdf | `8ec11211ba33bf88ad4e71acc6bf60fd0e7823cfa495b116872e2c287e4aebbb` | Have |
| 7 | India Revised Schedule M, G.S.R. 922(E), 28 Dec 2023 (official gazette PDF, 272 pages). Part I = English "PART I … MAIN PRINCIPLES" up to "PART II", extracted with `pdftotext -layout` | Binding | As notified | https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadGazette_NotificationsFiles/2023.12.28_DR_Final%20G.S.R.%20922(E)_Notification%20of%20Schedule%20M%20of.pdf | PDF `918704308629aefe5c800709d80b72c45de5b63cd44283a6268c3e4d8a9fd271` (same file the logbook used); Part I text `aa6fe0b8edaefac970a7ecff17261eee8bd9b4371550dcb64a61c43363804226` | Have |
| 8 | FDA guidance, Part 11 Scope and Application (Aug 2003) | Guidance: may only relax | Final | https://www.fda.gov/media/75414/download | `306013031df65004566799023444b3fd66d17dca72eea4c7eb5bacfd4a697ac5` | Have |
| 9 | FDA guidance, Data Integrity and Compliance with Drug CGMP, Q&A (Dec 2018) | Guidance: may only relax | Final | https://www.fda.gov/media/119267/download | `1b5074c592ed75035022566b6e151c219b5b6349414beaf4229e73117a0997c6` | Have |
| 10 | ICH Q10, Pharmaceutical Quality System (EU GMP Part III) | Guidance: may only relax or clarify | Step 4, Jun 2008 | https://database.ich.org/sites/default/files/Q10%20Guideline.pdf | `396b99197692a2fd386089b886dc7345e22b726fd6ebd0bbb5d2a0173b0ec292` | Have |

The eCFR files were fetched from the official versioner API. The sha256 values are of
the bytes the server returned on 2026-10-31. Point-in-time texts are reproducible from
the URL.

## Where each source touches a deviation system (first reading)

Paraphrased. The clause list is checked and narrowed in deliverable (c).

| Source | Clause | What it requires (paraphrase) |
|--------|--------|-------------------------------|
| 211 | 211.100(b) | Any departure from written production procedures is recorded and justified. |
| 211 | 211.192 | Unexplained discrepancies and spec failures are thoroughly investigated, even after distribution. The investigation extends to other batches and products that may be affected. A written record holds conclusions and follow-up. |
| 211 | 211.22(a), (d) | The quality unit can review records to make sure errors were fully investigated. Its procedures are in writing and followed. |
| 211 | 211.180(a), (c), (e)(2) | Batch-related records kept at least 1 year past batch expiry. Records available for inspection. Investigations under 211.192 reviewed at least annually (feeds the trend view). |
| 211 | 211.68(b) | Controls so only authorised people change records; input checked; backup. |
| P11 | 11.10, 11.50, 11.70, 11.100, 11.200, 11.300 | Audit trail, access control, sequence checks, signature manifestation (name, time, meaning), signature linked to record, unique IDs and password controls. |
| EU Ch1 | 1.4(xiv) | Root cause analysis at a suitable level. If the cause cannot be found, the most likely causes are identified. A human-error conclusion is justified. CAPAs identified and taken; their effectiveness monitored. |
| EU Ch1 | 1.8(vii) | Significant deviations fully recorded, investigated for root cause, and CAPA implemented. |
| EU Ch1 | 1.9(iv), 1.10(iv), 1.11 | QC deviations recorded and investigated. Product quality review covers significant deviations and CAPA effectiveness. CAPAs are managed to completion. |
| EU Ch4 | 4.1, 4.8, 4.9, 4.10–4.12, 4.29 | Good documentation: records at the time of action; corrections signed, dated, with the original still readable and a reason where needed; retention. Written procedures for investigations into deviations. |
| EU Ch5 | 5.15 | A deviation is approved in writing by a competent person, with QC/QA involved where appropriate. |
| EU Ch5 | 5.44 | A significant yield deviation is recorded and investigated. |
| A11 | 1, 4, 5, 7, 8, 9, 10, 12, 13, 14, 16, 17 | Risk-based validation, data checks, backups, printable copies, audit trail, access, incident management, e-signatures, continuity, archiving. |
| SchM | 1.5(m), 1.5(s) | Deviations, suspected defects and other problems are reported, investigated and recorded with suitable root cause analysis. The most likely root causes **shall** be identified, CAPA identified and taken, and CAPA effectiveness **shall** be monitored. Stricter wording than EU 1.4(xiv) ("should"). |
| SchM | 2.3.2(c), (d), (i); 2.3.3 | Annual product quality review covers failed batches, significant deviations and CAPA effectiveness. CAPA completed in a timely and effective manner under documented procedures (basis for due dates). |
| SchM | 3.1(6) | Significant deviations fully recorded and investigated for root cause, with CAPA implemented. |
| SchM | 18.2.2 | Deviations are handled under an approved procedure and authorised in writing by a designated person, with QC involved when appropriate. |
| SchM | 18.4.6; 18.5.12; 19.4(d), (f); 19.6.7; 19.8.1 | Significant yield deviations investigated. A divergence or batch failure is thoroughly investigated, extended to other batches and products **if necessary** (211.192 has no "if necessary": FDA wins), with a written record of conclusion and follow-up. QC deviations recorded and investigated. |
| SchM | 17.2.2, 17.2.6, 17.2.7, 17.2.8 | Signed and dated; an alteration is signed and dated, the original stays readable, with a reason where appropriate; records made at the time; kept at least 1 year past product expiry; electronic: authorised entry only, a record of changes and deletions, password access, critical entries checked, backup. |
| SchM | 20.1, 20.4, 20.6, 20.7, 20.8, 20.9 | Validation, access control, check on critical manual entries, incidents, change procedure, backup with no permanent loss. |

## Deliberately not used

GAMP 5, PIC/S PI 041, MHRA and WHO data-integrity guidance, the 2025 EU Annex 11 and
Chapter 4 drafts, ICH Q9 (QRM), 21 CFR 210/600, FDA OOS guidance. Reason: none is binding,
and the owner's test lets guidance only relax a rule. OOS lab investigations are a
laboratory process. If a site records an OOS as a deviation, the same screens work.

## What I need from the owner

1. **Schedule M:** no longer needed. I fetched the official gazette PDF from CDSCO (row 7).
   It is the same file, by sha256, that the logbook used. `maglesT/ebmr` would only serve as
   an optional domain reference.
2. **EU GMP Chapter 1:** no longer needed. I fetched rev 3 (in force 31 Jan 2013) from the
   official EU site (row 3).
3. **Repository:** please create an empty private repo, e.g. `maglesT/deviations`, and
   tell me its name. Until then the documents are kept locally in this session.

## Simplicity review

**Considered and dropped**
- ICH Q9 as a source: guidance only, and it pulls in risk-scoring engines that the owner excludes.
- FDA OOS guidance: covers a lab process, and the deviation flow already handles an OOS logged as a deviation.
- The 2025 Annex 11 / Ch4 drafts: not in force. They could add stricter rules too early.
- PIC/S, GAMP 5, WHO, MHRA: not binding. Nothing they add survives the "which binding clause breaks?" test.

**Kept that someone could call extra**
- EU Ch5 (5.15): the only EU clause that says who approves a deviation.
- 21 CFR 211.180(e): the annual review of 211.192 investigations. It is the binding reason for the simple trend view.
- FDA Part 11 Scope & Application and the DI Q&A: kept only so they can make Part 11 controls *less* strict (enforcement discretion), as in the logbook.
- ICH Q10: the brief names it. Kept only to relax or clarify (e.g. CAPA effectiveness "where appropriate").
