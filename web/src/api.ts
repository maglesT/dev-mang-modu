export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    // Validation problems listed by the server, shown to the user.
    public problems: string[] = [],
  ) {
    super(message ?? code);
  }
}

// background: polls that must not keep an idle session alive (server checks this header).
export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: object, background = false): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(background ? { 'x-background-poll': '1' } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message, data.problems ?? []);
  return data as T;
}

// D-08: three fixed roles.
export type Role = 'user' | 'qa' | 'admin';
export const ROLES: Role[] = ['user', 'qa', 'admin'];
export const ROLE_LABEL: Record<Role, string> = {
  user: 'User',
  qa: 'QA',
  admin: 'Admin',
};

export interface Me {
  id: number;
  username: string;
  fullName: string;
  roles: Role[];
  passwordChangeRequired: boolean;
}

export interface User {
  id: number;
  username: string;
  fullName: string;
  roles: Role[];
  active: boolean;
  locked: boolean;
  lastLoginAt: string | null;
}

export interface Alert {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}

// DV-16: times are shown in plant time with the zone label.
export function plantTime(iso: string | null): string {
  if (!iso) return '—';
  const s = new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return `${s} IST`;
}
