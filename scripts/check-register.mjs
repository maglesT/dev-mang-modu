// Program check of the compliance register: each clause anchor exists in its source
// text and the quoted phrase appears within the clause (the next WINDOW characters).
// Sources are git-ignored; run locally after fetching them (see docs/01-source-documents.md).
import { readFileSync } from 'node:fs';

const WINDOW = 3000;
const norm = (s) => s.replace(/[­]/g, '').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
  .replace(/[‐-―]/g, '-').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').toLowerCase();

const { sources, checks } = JSON.parse(readFileSync('compliance/register-checks.json', 'utf8'));
const texts = Object.fromEntries(Object.entries(sources).map(([k, p]) => [k, norm(readFileSync(p, 'utf8'))]));

let failed = 0;
for (const c of checks) {
  const t = texts[c.src];
  const anchor = norm(c.anchor), phrase = norm(c.phrase);
  let i = t.indexOf(anchor), ok = false;
  while (i >= 0 && !ok) {
    ok = t.slice(i, i + WINDOW).includes(phrase);
    i = t.indexOf(anchor, i + 1);
  }
  const status = t.includes(anchor) ? (ok ? 'PASS' : 'FAIL phrase not in clause') : 'FAIL clause not found';
  if (!ok) failed++;
  console.log(`${status.padEnd(26)} ${c.rule}  ${c.src} ${c.clause}  "${c.phrase}"`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
