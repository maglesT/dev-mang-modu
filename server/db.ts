import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export interface ConnectOptions {
  // Run as the restricted application role (no UPDATE/DELETE on audit_log; DV-15).
  role?: string;
  searchPath?: string;
}

export function connect(url: string, { role, searchPath }: ConnectOptions = {}, max = 10): Sql {
  // Sessions run in UTC so timestamps never depend on the server's local zone.
  const options = [role && `-c role=${role}`, searchPath && `-c search_path=${searchPath}`].filter(Boolean).join(' ');
  return postgres(url, {
    connection: { TimeZone: 'UTC', ...(options ? { options } : {}) },
    onnotice: () => {},
    max,
  });
}
