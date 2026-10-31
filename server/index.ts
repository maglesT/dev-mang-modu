import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleIntegrityCheck } from './integrity.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { role: config.DB_APP_ROLE });
const ai = config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL } : undefined;
// Read-only connections, a few at most (the other systems limit their report roles' connections).
const reader = (url: string) => ({ sql: connect(url, {}, 2), schema: 'report' });
const sources = {
  ...(config.LOGBOOK_REPORT_URL ? { logbook: reader(config.LOGBOOK_REPORT_URL) } : {}),
  ...(config.BATCHWRIGHT_REPORT_URL ? { batchwright: reader(config.BATCHWRIGHT_REPORT_URL) } : {}),
};
const app = await buildApp({ sql, logger: true, cookieSecure: config.COOKIE_SECURE, ai, sources });

await app.listen({ port: config.PORT, host: config.HOST });
const stopIntegrity = scheduleIntegrityCheck(sql, (msg) => app.log.info(msg), (msg) => app.log.error(msg));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopIntegrity();
    await app.close();
    await sql.end();
    // The read-only connections to the Logbook and Batchwright too.
    await Promise.all(Object.values(sources).map((x) => x.sql.end()));
    process.exit(0);
  });
}
