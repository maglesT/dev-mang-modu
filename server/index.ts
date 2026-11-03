import { createHash } from 'node:crypto';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';
import { oidcSignOn } from './signon.js';
import { sqlPeople } from './people.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
const ai = config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL } : undefined;
// Read-only connections, a few at most (the other systems limit their report roles' connections).
const reader = (url: string) => ({ sql: connect(url, {}, 2), schema: 'report' });
const sources = {
  ...(config.LOGBOOK_REPORT_URL ? { logbook: reader(config.LOGBOOK_REPORT_URL) } : {}),
  ...(config.BATCHWRIGHT_REPORT_URL ? { batchwright: reader(config.BATCHWRIGHT_REPORT_URL) } : {}),
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    await app.close();
    await sql.end();
    // The read-only connections to the Logbook and Batchwright too.
    await Promise.all([...Object.values(sources).map((x) => x.sql.end()), identity.end()]);
    process.exit(0);
  });
}
