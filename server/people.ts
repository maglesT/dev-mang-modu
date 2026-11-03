import type { Sql, Tx } from './db.js';

// D-42 slice 4 (platform PL-08, recipe §4, A11 5): who is active is core's. Deviations reads identity's
// report.employee_v1 with its own login and a second pool, and keeps no copy. Before an investigator or a CAPA owner
// is stored, the person is read through the view: unknown or inactive in core is refused at write.

export interface People {
  /** The core employee ids among `ids` that core lists as active. */
  active(ids: string[]): Promise<Set<string>>;
}

export const CONNECTION_OFF = 'Connection to core is off. Ask your administrator.';
export class ConnectionOff extends Error {
  statusCode = 503;
  constructor() { super(CONNECTION_OFF); }
}

// A cut link: the grant is gone (42501), the login is off (28000), identity cannot be reached or did not answer.
export const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '28000', '57P01', '57014', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED',
    'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};

/** Reads identity's employee view; a cut link throws ConnectionOff, nothing is served from a copy (platform D-02). */
export function sqlPeople(identity: Sql): People {
  return {
    active: async (ids) => {
      if (!ids.length) return new Set();
      try {
        // Read while a deviation or CAPA row is locked: a slow core answers "connection off" after 5 s, never hangs.
        const rows = await identity.begin('read only', async (tx) => {
          await tx`set local statement_timeout = '5s'`;
          return tx<{ id: string }[]>`select id::text from report.employee_v1 where id = any(${ids}::uuid[]) and active`;
        });
        return new Set(rows.map((r) => r.id));
      } catch (e) {
        if (isCut(e)) throw new ConnectionOff();
        throw e;
      }
    },
  };
}

/** Write-time check (PL-08): the local user may be stored as investigator or CAPA owner only if core has them active. */
export async function assignable(tx: Sql | Tx, people: People, userId: number): Promise<boolean> {
  const [u] = await tx<{ employee_id: string | null }[]>`select employee_id::text from users where id = ${userId}`;
  return !!u?.employee_id && (await people.active([u.employee_id])).has(u.employee_id);
}
