// One way of writing dates, times and history lines on screens and PDFs (suite display rules, 20 Nov 2026).
// Pure code: the web pages import this file too, so the screen and the PDF say the same thing.

const PLANT_TZ = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const parts = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: PLANT_TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: MONTHS[Number(p.month) - 1]!, year: p.year!, time: `${p.hour}:${p.minute}` };
};

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// One instant in plant time, 24-hour, to the minute (suite rule, as TrueBatch's plantClock): on screens
// "20 Nov, 21:21 IST", the year only when it is not this year; `full` (PDFs, printed copies): always the year,
// "20 Nov 2026, 21:21 IST".
export function plantDateTime(d: Date | string | null | undefined, full = true, now: Date = new Date()): string {
  if (d === null || d === undefined || d === '') return '—';
  if (typeof d === 'string' && DAY_ONLY.test(d)) return plantDay(d);
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  const p = parts(x);
  const year = full || p.year !== parts(now).year ? ` ${p.year}` : '';
  return `${p.day} ${p.month}${year}, ${p.time} IST`;
}

// "20 Nov 2026". A plain YYYY-MM-DD is that plant day; a timestamp is shown as its plant day.
export function plantDay(d: Date | string | null | undefined): string {
  if (d === null || d === undefined || d === '') return '—';
  if (typeof d === 'string' && DAY_ONLY.test(d)) {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    return `${day} ${MONTHS[m - 1]} ${y}`;
  }
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  const p = parts(x);
  return `${p.day} ${p.month} ${p.year}`;
}

export const STEP_WORDS: Record<string, string> = {
  classification: 'Awaiting classification', approval: 'Awaiting approval', investigation: 'Investigation',
  closure: 'Awaiting closure', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled by QA: not a deviation',
  open: 'Open', done: 'Done, awaiting QA', check: 'Effectiveness check due',
};

export const MEANING_WORDS: Record<string, string> = {
  approved: 'Approved', rejected: 'Rejected', investigation_complete: 'Investigation complete', verified: 'Verified',
  closed: 'Closed', reopened: 'Reopened', cancelled: 'Cancelled: not a deviation',
};

const ACTION_WORDS: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  'login.failed': 'Failed sign-in',
  'password.changed': 'Password changed',
  'password.change_failed': 'Password change refused',
  'user.created': 'User created',
  'user.updated': 'User changed',
  'user.locked': 'Account locked (too many wrong passwords)',
  'user.password_reset': 'Temporary password issued',
  'alert.acknowledged': 'Security alert acknowledged',
  'ai.suggested': 'Assistant suggestion asked',
  'area.created': 'Area added',
  'attachment.added': 'Attachment added',
  'attachment.withdrawn': 'Attachment withdrawn',
  'capa.raised': 'CAPA raised',
  'capa.corrected': 'CAPA corrected',
  'capa.done': 'CAPA done',
  'capa.verified': 'CAPA verified',
  'capa.checked': 'Effectiveness checked',
  'capa.due_changed': 'Due date changed',
  'data.fetched': 'Data fetched',
  'deviation.reported': 'Reported',
  'deviation.classified': 'Classified',
  'deviation.investigated': 'Investigation saved',
  'deviation.closed': 'Closed',
  'deviation.reopened': 'Reopened',
  'deviation.cancelled': 'Cancelled by QA: not a deviation',
  'deviation.capa_raised': 'CAPA raised',
  'deviation.target_date_changed': 'Target date changed',
  'deviation_type.created': 'Deviation type added',
  'deviation_type.lab_changed': 'Deviation type changed',
  'investigation.draft_saved': 'Investigation draft saved',
  'settings.updated': 'Settings changed',
  'signature.failed': 'Signature refused',
};

const sentence = (s: string) => {
  const w = s.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll(/[._]+/g, ' ').trim().toLowerCase();
  return w.replace(/^\w/, (c) => c.toUpperCase());
};

// A history action in words: "signed.cancelled" -> "Signed: Cancelled: not a deviation".
export function actionWords(a: string): string {
  if (ACTION_WORDS[a]) return ACTION_WORDS[a];
  if (a.startsWith('signed.')) {
    const m = a.slice('signed.'.length);
    return `Signed: ${MEANING_WORDS[m] ?? sentence(m)}`;
  }
  return sentence(a);
}

const KEY_WORDS: Record<string, string> = {
  step: 'Status', targetDate: 'Target date', dueDate: 'Due date', checkDue: 'Check due', labOos: 'OOS type',
  sha256: 'SHA-256', contentHash: 'Content hash', signatureId: 'Signature', attachmentId: 'Attachment', fetchId: 'Fetch',
  capas: 'CAPAs', capa: 'CAPA', eventAt: 'Event time', actionTakenAt: 'Action taken at', areaId: 'Area',
};

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function scalar(key: string, v: unknown, full: boolean): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return /id$/i.test(key) ? String(v) : v.toLocaleString('en-IN');
  const s = String(v);
  if (key === 'step') return STEP_WORDS[s] ?? sentence(s);
  if (ISO_TIME.test(s)) return plantDateTime(s, full);
  if (DAY_ONLY.test(s)) return plantDay(s);
  return s;
}

// An old or new value in a history line, in words: {"step":"classification"} -> "Status: Awaiting classification".
// `full`: times with the year (PDFs); screens pass false.
export function valueWords(v: unknown, key = '', full = true): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.length ? v.map((x) => valueWords(x, key, full)).join('; ') : '—';
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => {
        const inner = typeof x === 'object' && x !== null ? `(${valueWords(x, k, full) || '—'})` : scalar(k, x, full);
        return `${KEY_WORDS[k] ?? sentence(k)}: ${inner}`;
      })
      .join('; ');
  }
  return scalar(key, v, full);
}

// What an OOS was taken from, in words (display backlog 19 Nov 2026). LIMS migration 0031 adds batch_number, point_code
// and room_code to oos_v1 for an environmental-monitoring OOS: "point RM207-CP1, room RM-207, taken during batch TI260016".
// A product or material OOS: "FG-EX-10 Example tablets, lot EX26001". An EM OOS read before those columns (item kind ROOM
// ...) calls its lot_number the sampling point.
export interface OosWhere { itemKind?: string; itemCode?: string; itemName?: string; lot?: string; point?: string; room?: string; batch?: string }
const isProductKind = (k: string | undefined) => ['', 'product', 'material'].includes(String(k ?? '').trim().toLowerCase());
export const isEmOos = (o: OosWhere) => !!(o.point || o.room) || !isProductKind(o.itemKind);
export function oosWhere(o: OosWhere): string {
  if (!isEmOos(o)) return `${[o.itemCode, o.itemName].filter(Boolean).join(' ')}, lot ${o.lot ?? ''}`;
  const point = o.point || o.lot;
  const room = o.room || (String(o.itemKind ?? '').toLowerCase() === 'room' ? o.itemCode : '');
  return [point ? `point ${point}` : '', room ? `room ${room}` : '', o.batch ? `taken during batch ${o.batch}` : ''].filter(Boolean).join(', ')
    || [o.itemCode, o.itemName].filter(Boolean).join(' ');
}
// The area of an EM OOS: its room ("RM-207 Aseptic filling room (vials)" when LIMS names the room), not the QC laboratory.
export function oosRoomArea(o: OosWhere): string | null {
  if (!isEmOos(o)) return null;
  const room = o.room || (String(o.itemKind ?? '').toLowerCase() === 'room' ? o.itemCode : '');
  if (!room) return null;
  const name = String(o.itemKind ?? '').toLowerCase() === 'room' && o.itemCode === room ? o.itemName : '';
  return `${room}${name ? ` ${name}` : ''}`.slice(0, 200);
}
// "Assay of FG-EX-10 Example tablets, lot EX26001" / "Contact plate, grade B (CFU/plate), point RM207-CP1, room RM-207, ...".
export const oosWhat = (o: OosWhere & { test?: string }) => `${o.test ?? ''}${isEmOos(o) ? ',' : ' of'} ${oosWhere(o)}`;
