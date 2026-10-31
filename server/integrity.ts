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
  await audit(sql, {
    actorId,
    action: result.problems.length ? 'integrity.failed' : 'integrity.passed',
    objectType: 'system',
    objectId: 'integrity',
    new: { ...result, problems: result.problems.slice(0, 200), problemCount: result.problems.length },
  });
  return result;
}

type Version = { id: number; parent: number; kind: string; version: number; data: unknown; supersedes?: number | null };

async function check(sql: Sql): Promise<IntegrityResult> {
  const problems: string[] = [];

  const sections = await sql<Version[]>`
    select id::int, deviation_id::int as parent, kind, version, data, supersedes::int from sections order by deviation_id, kind, version`;
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
  // version it is on plus the report version current when it was signed, so any report version may match.
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const reports = new Map<number, unknown[]>();
  for (const s of sections) if (s.kind === 'report') reports.set(s.parent, [...(reports.get(s.parent) ?? []), s.data]);
  const capaById = new Map(capaVersions.map((v) => [v.id, v]));
  const sigs = await sql<{ id: number; object_type: string; object_id: number; meaning: string; content_hash: string }[]>`
    select id::int, object_type, object_id::int, meaning, content_hash from signatures order by id`;
  for (const g of sigs) {
    const target = g.object_type === 'section' ? sectionById.get(g.object_id) : capaById.get(g.object_id);
    if (!target) {
      problems.push(`Signature ${g.id} (${g.meaning}): the signed ${g.object_type} ${g.object_id} is missing.`);
      continue;
    }
    const candidates = g.object_type === 'section' && (g.meaning === 'approved' || g.meaning === 'rejected')
      ? (reports.get(target.parent) ?? []).map((r) => ({ report: r, classification: target.data }))
      : [target.data];
    if (!candidates.some((c) => contentHash(g.object_type, g.object_id, c) === g.content_hash)) {
      problems.push(`Signature ${g.id} (${g.meaning}) on ${g.object_type} ${g.object_id}: content changed after signing.`);
    }
  }

  // Attachments still match their SHA-256 (computed in the database, so files are not loaded into memory).
  const files = await sql<{ id: number; ok: boolean }[]>`select id::int, encode(sha256(data), 'hex') = sha256 as ok from attachments`;
  for (const f of files) if (!f.ok) problems.push(`Attachment ${f.id}: the file no longer matches its SHA-256.`);

  return { checkedAt: new Date(), sections: sections.length, capaVersions: capaVersions.length, signatures: sigs.length, attachments: files.length, problems };
}

// Runs the check once a day from the server process (DV-22, "periodically").
export function scheduleIntegrityCheck(sql: Sql, log: (msg: string) => void): () => void {
  const DAY = 24 * 3_600_000;
  const tick = async () => {
    try {
      const [last] = await sql<{ at: Date }[]>`
        select at from audit_log where object_type = 'system' and object_id = 'integrity' order by at desc limit 1`;
      if (last && Date.now() - last.at.getTime() < DAY) return;
      const r = await runIntegrityCheck(sql);
      log(r.problems.length ? `integrity check FAILED: ${r.problems.length} problem(s)` : `integrity check passed (${r.sections} sections, ${r.signatures} signatures)`);
    } catch (e) {
      log(`integrity check could not run: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(tick, 3_600_000);
  void tick();
  return () => clearInterval(timer);
}
