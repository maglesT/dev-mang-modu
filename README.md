# Deviations & CAPA

Deviation management and CAPA register for one pharmaceutical plant (US FDA, EU GMP,
Revised Schedule M). Plan and compliance register: `docs/`.

## Run locally
```
npm ci
export TEST_DATABASE_URL=postgres://dev_owner:dev@localhost:5432/dev_test
npm test            # Vitest on real PostgreSQL, one schema per test file
npm run test:e2e    # Playwright browser tests
docker compose -f ops/docker-compose.yml up --build
```
