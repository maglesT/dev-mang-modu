// E2E_PORT may be set when another app's browser tests hold 4173 on the same machine.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);
// D-63: the same app and schema with the QMS linked (it owns CAPA), on its own port.
export const E2E_QMS_PORT = E2E_PORT + 1;
export const QMS_URL = 'https://qms.example.test';
export const E2E_SCHEMA = 'e2e';
export const USERS = {
  admin: ['admin'],
  qa1: ['qa', 'user'],
  qa2: ['qa', 'user'],
  us1: ['user'],
  us2: ['user'],
  rep1: ['user'],
} as const;
// D-62: rep1 holds only the report right (deviations.deviation.report), as core may grant a reporter on the platform.
export const REPORT_ONLY = 'rep1';
