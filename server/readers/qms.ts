import type { Tx } from '../db.js';
import type { Source } from './logbook.js';

// D-63 (owner, 19 Nov 2026: "QMS owns CAPA"). When the QMS is linked (its platform link QMS_DATABASE_URL is set; apply
// writes it only while the link is on), Deviations raises no CAPA of its own: "Raise CAPA" opens the QMS new-CAPA screen
// with the deviation number, and the deviation page, the CAPA list, the closure check and the counts read the QMS's CAPAs
// from its report.capa_v1 (read-only). Without the link (Deviations sold alone) the local CAPA register works as before.
// Old local CAPAs stay readable and are still published in this app's own capa_v1 (D-40).
export const QMS_VIEWS = ['capa_v1'];
export const QMS_OFF = 'ASSURE link off: CAPAs are raised and read in ASSURE, which is not answering now. Try again in a few minutes.';
export const RAISE_IN_QMS = 'ASSURE is linked: CAPAs are raised in ASSURE, not here. Use "Raise CAPA in ASSURE".';

// The QMS screen for a new CAPA (one constant, easy to change). It takes ?source=deviation&ref=<deviation number>.
export const QMS_NEW_CAPA_PATH = '/capa/new';

/**
 * The QMS's web address: QMS_URL when set; else, on the Medhanta platform, the QMS host beside this app's own host
 * (apply serves each product at <product>.<domain>, and this app's sign-on return address is https://deviations.<domain>/cb).
 */
export function qmsBaseUrl(qmsUrl: string | undefined, ownRedirectUri: string): string | undefined {
  if (qmsUrl) return qmsUrl.replace(/\/+$/, '');
  try {
    const u = new URL(ownRedirectUri);
    return u.hostname.startsWith('deviations.') ? `${u.protocol}//qms.${u.hostname.slice('deviations.'.length)}${u.port ? `:${u.port}` : ''}` : undefined;
  } catch {
    return undefined;
  }
}

/** The QMS new-CAPA link, pre-filled with the deviation number when there is one. */
export const newCapaUrl = (base: string | undefined, deviationNumber?: string) => (base
  ? `${base}${QMS_NEW_CAPA_PATH}${deviationNumber ? `?source=deviation&ref=${encodeURIComponent(deviationNumber)}` : ''}`
  : null);

/** The link to the QMS: its read-only view, and its web address for the new-CAPA link. */
export type QmsSource = Source & { url?: string };

/** A QMS CAPA as the QMS publishes it (capa_v1, fixed columns). */
export interface QmsCapa {
  capa_number: string; title: string; status: string; status_text: string; source_kind: string; source_ref: string | null;
  owner_name: string | null; due_date: string | null; closed_at: string | null; effective: boolean | null; data_as_of: string | null;
}
/** Not counted as a CAPA of the deviation (closure check, counts): withdrawn in the QMS. */
export const CANCELLED = 'cancelled';
const OPEN_EXCLUDED = ['closed', CANCELLED];
export const isOpen = (c: Pick<QmsCapa, 'status'>) => !OPEN_EXCLUDED.includes(c.status);

const COLUMNS = `capa_number, title, status, status_text, source_kind, source_ref, owner_name, to_char(due_date, 'YYYY-MM-DD') as due_date,
  closed_at, effective, data_as_of`;
export const REGISTER_LIMIT = 1000;

async function read<T>(src: Source, f: (tx: Tx, view: string) => Promise<T>): Promise<T> {
  return (await src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '10s'`;
    return f(tx, `${src.schema}.capa_v1`);
  })) as T;
}

/** The QMS CAPAs raised for these deviations (source_kind deviation, source_ref = the deviation number). Throws when not readable. */
export const capasFor = (src: Source, numbers: string[]) => read(src, (tx, v) => tx<QmsCapa[]>`
  select ${tx.unsafe(COLUMNS)} from ${tx(v)} where source_kind = 'deviation' and source_ref = any(${numbers})
  order by due_date nulls last, capa_number`);

/** The QMS CAPA register, newest due first, at most REGISTER_LIMIT rows. Throws when not readable. */
export const allCapas = (src: Source) => read(src, (tx, v) => tx<QmsCapa[]>`
  select ${tx.unsafe(COLUMNS)} from ${tx(v)} order by (status in ('closed', 'cancelled')), due_date nulls last, capa_number desc limit ${REGISTER_LIMIT}`);

/** Open QMS CAPAs per deviation number, or null when the QMS is not linked or not answering (callers keep the local count). */
export async function openCounts(src: Source | undefined, numbers: string[], log: (m: string) => void = () => {}): Promise<Map<string, number> | null> {
  if (!src || numbers.length === 0) return null;
  try {
    const rows = await capasFor(src, numbers);
    const m = new Map<string, number>();
    for (const r of rows) if (isOpen(r) && r.source_ref) m.set(r.source_ref, (m.get(r.source_ref) ?? 0) + 1);
    return m;
  } catch (e) {
    log(`ASSURE CAPA read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Adds the open QMS CAPAs to each row's openCapas (one number), when the QMS answers. */
export async function withQmsOpen<T extends { number: string; openCapas: number }>(src: Source | undefined, rows: T[], log?: (m: string) => void): Promise<T[]> {
  const m = await openCounts(src, rows.map((r) => r.number), log);
  return m ? rows.map((r) => ({ ...r, openCapas: r.openCapas + (m.get(r.number) ?? 0) })) : rows;
}
