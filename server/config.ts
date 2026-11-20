import { z } from 'zod';
import { BATCH_PRODUCTS, linkSetting, type LinkSetting } from './readers/products.js';

// D-51, D-53 to D-55, D-57, D-59: each TrueBatch product's link (TRUEBATCH_DATABASE_URL, TRUEBATCH_PACKING_DATABASE_URL,
// TRUEBATCH_CAPSULES_DATABASE_URL, ...), written by the platform's apply only while that link is on. Absent = off.
const optional = z.string().trim().optional().transform((v) => v || undefined);
const links = Object.fromEntries(BATCH_PRODUCTS.map((p) => [linkSetting(p), optional])) as Record<LinkSetting, typeof optional>;

const schema = z.object({
  ...links,
  // The app connects as the restricted role deviations_app (DV-14, DV-15); migrations use MIGRATION_DATABASE_URL.
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  // Set only when DATABASE_URL logs in as the owner (single-box setup): the app then switches role.
  DB_APP_ROLE: z.string().optional(),
  // Set to false only for plain-HTTP development; production runs behind TLS.
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Sign-on through Medhanta core (D-43): written by the platform's apply.
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().default('deviations'),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_REDIRECT_URI: z.string().url(),
  // Plant-local display time zone (DV-16); storage is always UTC.
  DISPLAY_TZ: z.string().default('Asia/Kolkata'),
  // S9 (D-29): AI-suggested causes through Google Gemini. Without a key the feature is off.
  GEMINI_API_KEY: z.string().trim().optional().transform((v) => v || undefined),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-4-argon'),
  // S17 (D-37): read-only connection to the Logbook's report views. Without it, that
  // source shows as "not configured" and nothing else changes.
  // On the Medhanta platform (D-42) apply writes LOGBOOK_DATABASE_URL for the link to the Logbook's views instead.
  LOGBOOK_REPORT_URL: z.string().trim().optional().transform((v) => v || undefined),
  // D-60: LIMS's OOS view (report.oos_v1), written by the platform's apply only while the link to LIMS is on. Absent = off.
  LIMS_DATABASE_URL: optional,
  // D-66: Operations' CPV signals (report.cpv_signal_v1), written by the platform's apply only while the link is on. Absent = off.
  OPS_DATABASE_URL: optional,
  // D-63: the QMS's CAPA view (report.capa_v1), written by the platform's apply only while the link to the QMS is on.
  // Set = the QMS owns CAPA (Deviations raises none of its own); absent = Deviations' own CAPA register (sold alone).
  QMS_DATABASE_URL: optional,
  // D-63: the QMS's web address for the "Raise CAPA in QMS" link; absent = the QMS host beside this app's own host.
  QMS_URL: optional,
  // Core's employee view (identity report.employee_v1), read with this app's own login (D-42 slice 4, PL-08).
  IDENTITY_DATABASE_URL: z.string().url(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // On the Medhanta platform (D-42) apply names the product's own database DEVIATIONS_DATABASE_URL and the linked
  // Logbook database LOGBOOK_DATABASE_URL (D-48); standalone keeps LOGBOOK_REPORT_URL. Batchwright is retired (D-56).
  return schema.parse({
    ...env,
    DATABASE_URL: env.DATABASE_URL || env.DEVIATIONS_DATABASE_URL,
    LOGBOOK_REPORT_URL: env.LOGBOOK_REPORT_URL?.trim() || env.LOGBOOK_DATABASE_URL,
  });
}
