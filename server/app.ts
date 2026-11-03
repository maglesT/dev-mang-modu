import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql } from './db.js';
import type { SignOn } from './signon.js';
import { BACKGROUND_HEADER, SESSION_COOKIE, loadSession } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { alertRoutes } from './routes/alerts.js';
import { auditRoutes } from './routes/audit.js';
import { listRoutes } from './routes/lists.js';
import { deviationRoutes } from './routes/deviations.js';
import { investigationRoutes } from './routes/investigation.js';
import { signalRoutes } from './routes/signals.js';
import { aiRoutes, type AiOptions } from './routes/ai.js';
import { dataRoutes } from './routes/data.js';
import type { Sources } from './readers/fetch.js';
import type { People } from './people.js';
import { capaRoutes } from './routes/capas.js';
import { reportRoutes } from './routes/reports.js';
import { integrityRoutes } from './routes/integrity.js';

export const VERSION = '0.1.0';

export interface AppOptions {
  // Connection running as the restricted application role.
  sql: Sql;
  logger?: boolean;
  webRoot?: string;
  // Sign-on through Medhanta core (D-43); tests pass a stand-in.
  signOn: SignOn;
  // Key for the short signing proofs made after core re-authenticated a signer (D-43, PL-05).
  proofKey?: Buffer;
  // Secure flag on the session cookie; off only for plain-HTTP development.
  cookieSecure?: boolean;
  // S9: Gemini settings; the AI suggestions are off without them.
  ai?: AiOptions;
  // S17: read-only sources (Logbook, Batchwright); each is optional.
  sources?: Sources;
  // Core's employee view, for the write-time check of investigators and CAPA owners (D-42 slice 4, PL-08).
  people: People;
}

export async function buildApp({ sql, signOn, proofKey = randomBytes(32), logger = false, webRoot, cookieSecure = true, ai, sources = {}, people }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: true });
  app.decorate('cookieSecure', cookieSecure);
  app.decorate('proofKey', proofKey);
  app.decorate('people', people);
  await app.register(fastifyCookie);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Writes must be JSON: together with SameSite=Strict cookies this blocks cross-site form posts.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_required' });
    }
    const sid = req.cookies[SESSION_COOKIE];
    // Logout works from the cookie itself, so an ended session still ends core's session too (shared terminals).
    if (sid && req.url !== '/api/logout') req.user = (await loadSession(sql, signOn, sid, !req.headers[BACKGROUND_HEADER])) ?? undefined;
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      const [row] = await sql<{ now: Date }[]>`select now() as now`;
      return { status: 'ok', version: VERSION, db: 'ok', serverTime: row!.now.toISOString() };
    } catch {
      return reply.code(503).send({ status: 'error', version: VERSION, db: 'unreachable' });
    }
  });

  authRoutes(app, sql, signOn);
  alertRoutes(app, sql);
  auditRoutes(app, sql);
  listRoutes(app, sql);
  deviationRoutes(app, sql);
  investigationRoutes(app, sql);
  signalRoutes(app, sql);
  aiRoutes(app, sql, ai);
  dataRoutes(app, sql, sources);
  capaRoutes(app, sql);
  reportRoutes(app, sql);
  integrityRoutes(app, sql);

  // In production the built web UI is served from the same process.
  const root = webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  if (existsSync(path.join(root, 'index.html'))) {
    await app.register(fastifyStatic, { root });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    cookieSecure: boolean;
    proofKey: Buffer;
    people: People;
  }
}
