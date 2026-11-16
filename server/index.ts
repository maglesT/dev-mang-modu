import { createHash } from 'node:crypto';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';
import { oidcSignOn } from './signon.js';
import { sqlPeople } from './people.js';
import { scheduleAutoRaise } from './autoraise.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
const ai = config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL } : undefined;
// Read-only connections, a few at most (the other systems limit their report roles' connections).
const reader = (url: string) => ({ sql: connect(url, {}, 2), schema: 'report' });
const sources = {
  ...(config.LOGBOOK_REPORT_URL ? { logbook: reader(config.LOGBOOK_REPORT_URL) } : {}),
  ...(config.BATCHWRIGHT_REPORT_URL ? { batchwright: reader(config.BATCHWRIGHT_REPORT_URL) } : {}),
  ...(config.TRUEBATCH_DATABASE_URL ? { truebatch: reader(config.TRUEBATCH_DATABASE_URL) } : {}),
};
// D-53: TrueBatch Tablets Packing is read for its deviation notes only (not by "Fetch related data").
const packing = config.TRUEBATCH_PACKING_DATABASE_URL ? reader(config.TRUEBATCH_PACKING_DATABASE_URL) : undefined;
// D-54: TrueBatch Injectables, the same way (its deviation notes only).
const injectables = config.TRUEBATCH_INJECTABLES_DATABASE_URL ? reader(config.TRUEBATCH_INJECTABLES_DATABASE_URL) : undefined;
// Core's employee view: a small second pool, read with this app's own login (PL-08).
const identity = connect(config.IDENTITY_DATABASE_URL, {}, 2);
const signOn = oidcSignOn({ issuer: config.OIDC_ISSUER, clientId: config.OIDC_CLIENT_ID, clientSecret: config.OIDC_CLIENT_SECRET,
  redirectUri: config.OIDC_REDIRECT_URI });
// The signing-proof key is derived from the OIDC client secret, so every instance of the app agrees on it.
const proofKey = createHash('sha256').update(`deviations-signing-proof:${config.OIDC_CLIENT_SECRET}`).digest();
const app = await buildApp({ sql, signOn, proofKey, logger: true, cookieSecure: config.COOKIE_SECURE, ai, sources, people: sqlPeople(identity) });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg), (msg) => app.log.error(msg));
// D-50, D-51, D-53: missed limits the Logbook publishes and the deviation notes without a number of TrueBatch and
// TrueBatch Packing are filed as deviations (each only with its link).
const stopAuto = sources.logbook || sources.truebatch || packing || injectables
  ? scheduleAutoRaise(sql, { logbook: sources.logbook, truebatch: sources.truebatch, truebatch_packing: packing, truebatch_injectables: injectables }, (msg) => app.log.info(msg)) : () => {};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    stopAuto();
    await app.close();
    await sql.end();
    // The read-only connections to the Logbook, Batchwright, TrueBatch and Packing too.
    await Promise.all([...[...Object.values(sources), ...(packing ? [packing] : []), ...(injectables ? [injectables] : [])].map((x) => x.sql.end()), identity.end()]);
    process.exit(0);
  });
}
