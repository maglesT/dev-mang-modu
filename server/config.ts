import { z } from 'zod';

const schema = z.object({
  // The app connects as the restricted role deviations_app (DV-14, DV-15); migrations use MIGRATION_DATABASE_URL.
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  // Set only when DATABASE_URL logs in as the owner (single-box setup): the app then switches role.
  DB_APP_ROLE: z.string().optional(),
  // Set to false only for plain-HTTP development; production runs behind TLS.
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Plant-local display time zone (DV-16); storage is always UTC.
  DISPLAY_TZ: z.string().default('Asia/Kolkata'),
  // S9 (D-29): AI-suggested causes through Google Gemini. Without a key the feature is off.
  GEMINI_API_KEY: z.string().trim().optional().transform((v) => v || undefined),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-4-argon'),
  // S17 (D-37): read-only connections to the Logbook and Batchwright report views. Without one, that
  // source shows as "not configured" and nothing else changes.
  // On the Medhanta platform (D-42) apply writes LOGBOOK_DATABASE_URL for the link to the Logbook's views instead.
  LOGBOOK_REPORT_URL: z.string().trim().optional().transform((v) => v || undefined),
  BATCHWRIGHT_REPORT_URL: z.string().trim().optional().transform((v) => v || undefined),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // On the Medhanta platform (D-42) apply names the product's own database DEVIATIONS_DATABASE_URL and the linked
  // Logbook database LOGBOOK_DATABASE_URL. Batchwright is not on the platform yet: BATCHWRIGHT_REPORT_URL as today.
  return schema.parse({
    ...env,
    DATABASE_URL: env.DATABASE_URL || env.DEVIATIONS_DATABASE_URL,
    LOGBOOK_REPORT_URL: env.LOGBOOK_REPORT_URL?.trim() || env.LOGBOOK_DATABASE_URL,
  });
}
