// Runs the integrity check (DV-22) from the command line, e.g. after restoring a backup.
// Exit code 1 when problems are found. Usage: DATABASE_URL=... [DB_APP_ROLE=deviations_app] npm run integrity
import { connect } from '../server/db.js';
import { runIntegrityCheck } from '../server/integrity.js';

// On the Medhanta platform (D-42) apply names the product's database DEVIATIONS_DATABASE_URL.
const url = process.env.DATABASE_URL || process.env.DEVIATIONS_DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DEVIATIONS_DATABASE_URL) is required');
const sql = connect(url, { role: process.env.DB_APP_ROLE });
const r = await runIntegrityCheck(sql);
console.log(`sections: ${r.sections}, CAPA versions: ${r.capaVersions}, signatures: ${r.signatures}, attachments: ${r.attachments}, data fetches: ${r.dataFetches}, problems: ${r.problems.length}`);
for (const p of r.problems.slice(0, 50)) console.log(`  ${p}`);
await sql.end();
process.exit(r.problems.length ? 1 : 0);
