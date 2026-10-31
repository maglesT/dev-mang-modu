import type { Sql } from './db.js';
import { audit } from './audit.js';
import { contentHash } from './signatures.js';

// DV-22 (A11 7.1, P11 11.10(c), SchM 20.4): re-read every record, check that version chains are
// complete, that each signature still matches the content it signed, and that each attachment still
// matches its SHA-256. The result is written to the audit trail.

export interface IntegrityResult {
  checkedAt: Date;
  sections: number;
  capaVersions: number;
  signatures: number;
  attachments: number;
  problems: string[];
}

export async function runIntegrityCheck(sql: Sql, actorId: number | null = null): Promise<IntegrityResult> {
  // All reads from one snapshot, so records saved during the check cannot look inconsistent.
  const result = await sql.begin('isolation level repeatable read read only', (tx) => check(tx as unknown as Sql));
  // A failed check is raised as an on-screen alert for Admin and QA, like a lockout (DV-18), until acknowledged.
  if (result.problems.length) {
    await sql`insert into alerts (kind, message)
      values ('integrity_failed', ${`Integrity check found ${result.problems.length} problem(s). See the Audit trail page.`})`;
  }
  await audit(sql, {
    actorId,
    action: result.problems.length ? 'integrity.failed' : 'integrity.passed',
    objectType: 'system',
    objectId: 'integrity',
    new: { ...result, problems: result.problems.slice(0, 200), problemCount: result.problems.length },
  });
  return result;
}

type Version = { id: number; parent: number; kind: string; version: number; data: unknown; supersedes?: number | null; saved_at?: Date };

async function check(sql: Sql): Promise<IntegrityResult> {
  const problems: string[] = [];

  const sections = await sql<Version[]>`
    select id::int, deviation_id::int as parent, kind, version, data, supersedes::int, saved_at from sections order by deviation_id, kind, version`;
  const capaVersions = await sql<Version[]>`
    select id::int, capa_id::int as parent, 'capa' as kind, version, data from capa_versions order by capa_id, version`;

  // Version chains: 1..n without gaps; a section version points to the one before it.
  const chain = (rows: Version[], label: string, withLink: boolean) =>
    rows.forEach((v, i) => {
      const prev = rows[i - 1];
      const same = prev && prev.parent === v.parent && prev.kind === v.kind;
      const expected = same ? prev.version + 1 : 1;
      if (v.version !== expected) problems.push(`${label} ${v.parent} (${v.kind}): version ${v.version} out of sequence.`);
      if (withLink && v.supersedes !== (same ? prev.id : null)) problems.push(`${label} ${v.parent} (${v.kind}): version ${v.version} does not point to the one before it.`);
    });
  chain(sections, 'Deviation', true);
  chain(capaVersions, 'CAPA', false);

  // Signatures against the content they signed. A planned-deviation approval covers the classification
  // version it is on plus the report version that was current when it was signed.
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const reports = new Map<number, Version[]>();
  for (const s of sections) if (s.kind === 'report') reports.set(s.parent, [...(reports.get(s.parent) ?? []), s]);
  const reportAt = (deviationId: number, at: Date) =>
    (reports.get(deviationId) ?? []).filter((r) => r.saved_at! <= at).at(-1)?.data;
  const capaById = new Map(capaVersions.map((v) => [v.id, v]));
  const sigs = await sql<{ id: number; object_type: string; object_id: number; meaning: string; content_hash: string; signed_at: Date }[]>`
    select id::int, object_type, object_id::int, meaning, content_hash, signed_at from signatures order by id`;
  for (const g of sigs) {
    const target = g.object_type === 'section' ? sectionById.get(g.object_id) : capaById.get(g.object_id);
    if (!target) {
      problems.push(`Signature ${g.id} (${g.meaning}): the signed ${g.object_type} ${g.object_id} is missing.`);
      continue;
    }
    const content = g.object_type === 'section' && (g.meaning === 'approved' || g.meaning === 'rejected')
      ? { report: reportAt(target.parent, g.signed_at), classification: target.data }
      : target.data;
    if (contentHash(g.object_type, g.object_id, content) !== g.content_hash) {
      problems.push(`Signature ${g.id} (${g.meaning}) on ${g.object_type} ${g.object_id}: content changed after signing.`);
    }
  }

  // The audit trail holds an independent copy of every signature hash: each must still have its signature
  // with the same hash, and each signature its audit row (catches deleted signatures and rewritten hashes).
  const signedAudit = await sql<{ signature_id: number; hash: string }[]>`
    select (new_value->>'signatureId')::int as signature_id, new_value->>'contentHash' as hash
    from audit_log where action like 'signed.%' and new_value ? 'signatureId'`;
  const sigById = new Map(sigs.map((g) => [g.id, g]));
  const auditedSigs = new Set<number>();
  for (const a of signedAudit) {
    auditedSigs.add(a.signature_id);
    const g = sigById.get(a.signature_id);
    if (!g) problems.push(`Signature ${a.signature_id}: in the audit trail but missing from the records.`);
    else if (g.content_hash !== a.hash) problems.push(`Signature ${a.signature_id}: its hash differs from the one in the audit trail.`);
  }
  for (const g of sigs) if (!auditedSigs.has(g.id)) problems.push(`Signature ${g.id}: no audit row.`);

  // Attachments still match their SHA-256 (computed in the database, so files are not loaded into memory),
  // and the SHA-256 recorded in the audit trail when they were added (catches deleted files and rewritten hashes).
  const files = await sql<{ id: number; ok: boolean; sha256: string }[]>`select id::int, encode(sha256(data), 'hex') = sha256 as ok, sha256 from attachments`;
  const added = new Map((await sql<{ id: number; sha256: string }[]>`
    select (new_value->>'attachmentId')::int as id, new_value->>'sha256' as sha256 from audit_log where action = 'attachment.added'`).map((a) => [a.id, a.sha256]));
  for (const f of files) {
    if (!f.ok) problems.push(`Attachment ${f.id}: the file no longer matches its SHA-256.`);
    if (added.get(f.id) !== f.sha256) problems.push(`Attachment ${f.id}: its SHA-256 differs from the one in the audit trail.`);
  }
  const fileIds = new Set(files.map((f) => f.id));
  for (const id of added.keys()) if (!fileIds.has(id)) problems.push(`Attachment ${id}: in the audit trail but missing from the records.`);

  // A closed deviation has a signed latest closure section; a closed CAPA has its closing signature.
  const closed = await sql<{ id: number; number: string; ok: boolean }[]>`
    select d.id::int, d.number, exists (select 1 from latest_sections l join signatures g on g.object_type = 'section' and g.object_id = l.id and g.meaning = 'closed'
      where l.deviation_id = d.id and l.kind = 'closure') as ok
    from deviations d where d.step = 'closed'`;
  for (const d of closed) if (!d.ok) problems.push(`Deviation ${d.number}: closed without a signed closure.`);
  const closedCapas = await sql<{ number: string; ok: boolean }[]>`
    select c.number, exists (select 1 from capa_versions v join signatures g on g.object_type = 'capa' and g.object_id = v.id
      and g.meaning in ('verified', 'closed') where v.capa_id = c.id and v.version = (select max(version) from capa_versions where capa_id = c.id)) as ok
    from capas c where c.step = 'closed'`;
  for (const c of closedCapas) if (!c.ok) problems.push(`CAPA ${c.number}: closed without its closing signature.`);

  return { checkedAt: new Date(), sections: sections.length, capaVersions: capaVersions.length, signatures: sigs.length, attachments: files.length, problems };
}

// Runs the check once a day from the server process (DV-22, "periodically").
export function scheduleIntegrityCheck(sql: Sql, log: (msg: string) => void, logError: (msg: string) => void = log): () => void {
  const DAY = 24 * 3_600_000;
  const tick = async () => {
    try {
      const [last] = await sql<{ at: Date }[]>`
        select at from audit_log where object_type = 'system' and object_id = 'integrity' order by at desc limit 1`;
      if (last && Date.now() - last.at.getTime() < DAY) return;
      const r = await runIntegrityCheck(sql);
      (r.problems.length ? logError : log)(r.problems.length ? `integrity check FAILED: ${r.problems.length} problem(s)` : `integrity check passed (${r.sections} sections, ${r.signatures} signatures)`);
    } catch (e) {
      logError(`integrity check could not run: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(tick, 3_600_000);
  void tick();
  return () => clearInterval(timer);
}
