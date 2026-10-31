// CI only (DV-22): puts one signed, closed deviation with an attachment and one verified CAPA into the
// database at DATABASE_URL, so the backup → restore → integrity round-trip runs on real JSONB and bytea data.
import { buildApp } from '../server/app.js';
import { connect } from '../server/db.js';
import { hashPassword } from '../server/passwords.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const owner = connect(url);
const pw = 'Seed-Password-77';
const hash = await hashPassword(pw);
for (const [u, role] of [['seedadmin', 'admin'], ['seedqa', 'qa'], ['seedqa2', 'qa'], ['seeduser', 'user']] as const) {
  const [row] = await owner<{ id: number }[]>`insert into users (username, full_name, password_hash, must_change_password)
    values (${u}, ${u.toUpperCase()}, ${hash}, false) returning id::int`;
  await owner`insert into user_roles (user_id, role) values (${row!.id}, ${role})`;
}
await owner.end();

const sql = connect(url, { role: 'dev_app' });
const app = await buildApp({ sql, webRoot: '/nonexistent', cookieSecure: false });
const login = async (u: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw } });
  return `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
};
const call = async (cookie: string, method: 'GET' | 'POST', path: string, payload?: object) => {
  const res = await app.inject({ method, url: path, headers: { cookie }, ...(method === 'POST' ? { payload: payload ?? {} } : {}) });
  if (res.statusCode >= 300) throw new Error(`${path}: ${res.statusCode} ${res.body}`);
  return res.json();
};
const sig = (u: string) => ({ username: u, password: pw });
const [admin, qa, qa2, user] = [await login('seedadmin'), await login('seedqa'), await login('seedqa2'), await login('seeduser')];
const areaId = (await call(admin, 'POST', '/api/areas', { name: 'Seed area' })).id;
const typeId = (await call(admin, 'POST', '/api/deviation-types', { name: 'Seed type' })).id;
const people = await call(qa, 'GET', '/api/people');
const userId = people.find((p: { username: string }) => p.username === 'seeduser').id;
const { id } = await call(user, 'POST', '/api/deviations', {
  planned: false, title: 'Seed – ünïcödé ✓', description: 'Seeded for the backup check.', areaId, eventAt: new Date(Date.now() - 60_000).toISOString(),
  products: [{ product: 'Seed product', batch: 'SEED-1' }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'None.',
});
await call(qa, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId, impact: 'x', investigatorId: userId, productBatchChecked: true });
await call(user, 'POST', `/api/deviations/${id}/investigate`, { data: { rootCause: 'x', otherBatches: [], noOtherReason: 'x', conclusion: 'x' }, signature: sig('seeduser') });
await call(user, 'POST', `/api/deviations/${id}/attachments`, { filename: 'seed.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 seed').toString('base64') });
await call(qa2, 'POST', `/api/deviations/${id}/close`, { data: { summary: 'Seed', noCapaReason: 'Seed' }, signature: sig('seedqa2') });
const due = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
const capa = (await call(qa, 'POST', '/api/capas', { source: 'deviation', deviationId: id, type: 'corrective', description: 'x', ownerId: userId, dueDate: due })).id;
await call(user, 'POST', `/api/capas/${capa}/done`, { note: 'x' });
const k = await call(qa, 'GET', `/api/capas/${capa}`);
await call(qa, 'POST', `/api/capas/${capa}/verify`, { effectiveness: { mode: 'trend', reason: 'x' }, versionId: k.versions.at(-1).id, signature: sig('seedqa') });
await app.close();
await sql.end();
console.log('seeded one closed deviation with an attachment and one verified CAPA');
