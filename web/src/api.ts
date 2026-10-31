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
  actorUsername: string | null;
  subject: string | null;
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

// DV-16: the meaning of each signature, in words.
export const MEANING_LABEL: Record<string, string> = {
  approved: 'Approved (planned deviation may proceed)',
  rejected: 'Rejected',
  investigation_complete: 'Investigation complete',
  verified: 'Verified',
  closed: 'Closed',
  reopened: 'Reopened',
};

export type Step = 'classification' | 'approval' | 'investigation' | 'closure' | 'closed' | 'rejected';
// What the step means and who acts next, in plain words.
export const STEP_LABEL: Record<Step, string> = {
  classification: 'Awaiting classification',
  approval: 'Awaiting approval',
  investigation: 'Investigation',
  closure: 'Awaiting closure',
  closed: 'Closed',
  rejected: 'Rejected',
};
export const STEP_CHIP: Record<Step, string> = {
  classification: 'chip-warn',
  approval: 'chip-warn',
  investigation: 'chip-info',
  closure: 'chip-info',
  closed: 'chip-ok',
  rejected: 'chip',
};
export const CLASS_LABEL: Record<string, string> = { minor: 'Minor', major: 'Major', critical: 'Critical' };

export interface NamedItem { id: number; name: string; active: boolean }
export interface Settings { siteName: string; targetDaysMinor: number; targetDaysMajor: number; targetDaysCritical: number }

export interface DeviationItem {
  id: number;
  number: string;
  planned: boolean;
  step: Step;
  classification: string | null;
  targetDate: string | null;
  overdue: boolean;
  reportedAt: string;
  title: string;
  area: string | null;
  reporter: string;
  investigator: string | null;
  batches: string;
  waitingForMe: boolean;
}

export interface SectionVersion {
  id: number;
  kind: 'report' | 'classification' | 'investigation' | 'closure' | 'target_date';
  version: number;
  data: Record<string, unknown>;
  savedAt: string;
  savedBy: string;
  reason: string | null;
  latest: boolean;
}

export interface Deviation {
  id: number;
  number: string;
  planned: boolean;
  step: Step;
  classification: string | null;
  targetDate: string | null;
  overdue: boolean;
  reportedAt: string;
  reporterId: number;
  reporter: string;
  investigatorId: number | null;
  investigator: string | null;
  area: string | null;
  sections: SectionVersion[];
  signatures: { id: number; sectionId: number; printedName: string; meaning: string; signedAt: string }[];
  batches: { role: 'own' | 'other'; product: string; batch: string; outcome: string | null }[];
  history: { id: number; at: string; actor: string | null; action: string; oldValue: unknown; newValue: unknown; reason: string | null }[];
  approvalHash: string | null;
}

// A datetime-local value in the browser's own zone.
export function localInputValue(d: Date = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

// A plain date (YYYY-MM-DD) in words.
export function plantDate(d: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
}
