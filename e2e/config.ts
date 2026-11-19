export const E2E_PORT = 4173;
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
