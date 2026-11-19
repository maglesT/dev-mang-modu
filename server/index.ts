import { createHash } from 'node:crypto';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';
import { oidcSignOn } from './signon.js';
import { sqlPeople } from './people.js';
import { scheduleAutoRaise } from './autoraise.js';
import type { Sources } from './readers/fetch.js';
import { BATCH_PRODUCTS, linkSetting } from './readers/products.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
const ai = config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL } : undefined;
// Read-only connections, a few at most (the other systems limit their report roles' connections).
const reader = (url: string) => ({ sql: connect(url, {}, 2), schema: 'report' });
// D-51, D-53, D-54, D-55, D-57, D-59: the TrueBatch products, each through its own link (apply writes each URL only while
// that link is on): read by "Fetch related data", for the report form's batch list, and for their deviation notes.
const sources: Sources = {
  ...(config.LOGBOOK_REPORT_URL ? { logbook: reader(config.LOGBOOK_REPORT_URL) } : {}),
  // D-60: LIMS, for the OOS pick and the filing of an OOS phase II investigation.
  ...(config.LIMS_DATABASE_URL ? { lims: reader(config.LIMS_DATABASE_URL) } : {}),
  ...Object.fromEntries(BATCH_PRODUCTS.flatMap((p) => { const url = config[linkSetting(p)]; return url ? [[p, reader(url)]] : []; })),
};
// Core's employee view: a small second pool, read with this app's own login (PL-08).
const identity = connect(config.IDENTITY_DATABASE_URL, {}, 2);
const signOn = oidcSignOn({ issuer: config.OIDC_ISSUER, clientId: config.OIDC_CLIENT_ID, clientSecret: config.OIDC_CLIENT_SECRET,
  redirectUri: config.OIDC_REDIRECT_URI });
// The signing-proof key is derived from the OIDC client secret, so every instance of the app agrees on it.
const proofKey = createHash('sha256').update(`deviations-signing-proof:${config.OIDC_CLIENT_SECRET}`).digest();
const app = await buildApp({ sql, signOn, proofKey, logger: true, cookieSecure: config.COOKIE_SECURE, ai, sources, people: sqlPeople(identity) });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg), (msg) => app.log.error(msg));
// D-50, D-51, D-53, D-59: missed limits the Logbook publishes and the deviation notes without a number of each TrueBatch
// product are filed as deviations (each only with its link).
const stopAuto = Object.keys(sources).length ? scheduleAutoRaise(sql, sources, (msg) => app.log.info(msg)) : () => {};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    stopAuto();
    await app.close();
    await sql.end();
    // The read-only connections to the Logbook and the TrueBatch products too.
    await Promise.all([...Object.values(sources).map((x) => x!.sql.end()), identity.end()]);
    process.exit(0);
  });
}
