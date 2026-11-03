# Cutover runbook: the live Deviations & CAPA onto the Medhanta platform (slice 6)

Status: written, **not run**. Adapted from the MMS runbook (its `docs/07-cutover-runbook.md`). It is applied at the
**joint go-live**, when all products go live on the platform together (owner decision, 3 Nov 2026), and **only with
the owner's approval**, on the owner's server, in a window the owner sets. Rules met: platform PL-13 (data moves
checked), PL-10 (changes through the config, with a change reference), A11 10 / CP-07 (change control).

What moves: every record of the **live** installation (compose project `deviations-live`, branch `standalone`,
2b49b4a). The demo project (`deviations`) is not moved and is not touched. People keep their logins and passwords
and sign in at core from then on. Deviations, sections, batches, signatures, attachments, CAPAs, data fetches,
alerts, settings, areas, types and the audit trail are copied unchanged and checked (`db/move-to-platform.ts`, D-45).
Deviations has no master data to move (D-42).

## Before the day

1. **Live commit.** Check that the live project runs `standalone` at 2b49b4a or a later `standalone` fix:
   `git -C /opt/deviations log -1 --format=%H`. The move was tested against that schema.
2. **Platform installed** on the owner's server, with the first core administrator, and the Logbook already moved
   (Deviations reads the Logbook's views). **Domain** (lead decision for all runbooks): the platform `domain` is
   `187-126-126-5.sslip.io`, so the platform Deviations runs at `deviations.187-126-126-5.sslip.io`, the name used
   today; no redirect is needed. Apply registers `https://deviations.187-126-126-5.sslip.io/cb` with core as its
   sign-on return address. The old proxy entries (the demo's and `deviations-live`'s) give up that name at the freeze
   (step 1), so the platform's Caddy can take it.
3. **Platform release with the Deviations pin** at the latest Deviations merge (`apps/deviations/manifest.json` in
   databsee).
4. **Customer config ready, not yet applied**:
   - `licences` gains `deviations`;
   - `links.deviations: { identity: [employee_v1], logbook: [equipment_v1, entry_v1, calibration_v1, logbook_sop_v1] }`;
   - if the QMS is licensed, `links.qms.deviations: [capa_v1]` (the QMS reads the CAPA register);
   - secrets: `logins.deviations_app`, `oidc.clients.deviations`, and under `env.deviations` the `GEMINI_API_KEY`
     from the old `ops/live.env` (AI suggestions as today). `BATCHWRIGHT_REPORT_URL` stays unset: Batchwright is not on
     the platform yet, so its data shows as "not configured" until it moves.
5. **From the site** (keep them with the change record):
   - the **identity verification text** (21 CFR 11.100(b)): who verified the moved people's identity and how;
   - the **link list**: Deviations logins that are the same person as an existing core login (for example someone
     already moved with the Logbook or MMS). Only these are linked; any other login core already has stops the move;
   - confirmation of the rehearsal's **mapping report**: logins starting with a digit get a `u` prefix (`1ravi` →
     `u1ravi`); people deactivated or locked in Deviations get no codes, also when linked;
   - what the rehearsal's dry run lists **to correct before the freeze** (each stops the move): a login core refuses
     even with the prefix; a linked core person who is inactive in core; a linked core person who already holds
     Deviations codes while deactivated or locked here (take the codes away in core).
6. **Rehearsal on the owner's own server**: steps 2–6 below on last night's backup of `deviations-live`, the real
   move and its checks, not only `--dry-run`; then restore the snapshot of step 4a. The move must end "moved" with no
   problems. Tell the people with a prefixed login their new login.
7. Tell users the window, the new address, and that their login and password stay the same.
8. **Image tag.** `plat` commands that start the Deviations image need the pinned commit as its tag (apply sets it,
   a manual `docker compose` does not):
   `export DEVIATIONS_COMMIT=$(jq -r .source.commit /opt/medhanta/current/apps/deviations/manifest.json)`.

## On the day

Record every step's time, who did it, and its output in the change record, with the customer's change reference.
`old` below is the live project's command from the README, run in `/opt/deviations`:
`docker compose -p deviations-live --env-file ops/live.env -f ops/docker-compose.yml -f ops/live.override.yml`.
`plat` is `docker compose -f /opt/medhanta/current/deploy/compose.yml`.

1. **Freeze.** Stop the old app and leave its database running: `old stop app`. From here nobody can add records.
   Remove the old TLS proxy entries for the Deviations name (demo and live) and reload that proxy, so the name is free
   for the platform.
2. **Check, then back up the frozen data.** First the integrity check (it adds its own audit row, so it runs before
   the dump): `old run --rm app node dist/db/integrity.js` (exit 0 required). Then the dump and its checksum:
   `old exec -T db pg_dump -U dev_owner --format=custom deviations > /backups/deviations-freeze.dump && sha256sum /backups/deviations-freeze.dump`.
   From here the old database is not touched again.
3. **Restore the dump into a scratch database on the platform server** (the move reads this copy; the live
   database has no port on the host):
   ```sh
   plat exec -T db createdb -U <superuser> deviations_move_source
   plat exec -T db psql -U <superuser> -c "revoke all on database deviations_move_source from public"
   plat exec -T db pg_restore -U <superuser> --no-owner --no-privileges -d deviations_move_source < /backups/deviations-freeze.dump
   ```
   The dump's role `dev_app` does not exist on the platform: `--no-owner --no-privileges` leaves its grants out, and
   the move reads the copy as the superuser.
4. **Licence on.** Commit the prepared config; apply runs Deviations' migrations and starts it. **Nobody opens the
   Deviations address until step 6**: a sign-on writes a `users` and an audit row, and the move needs an empty
   database. Check:
   `plat exec -T db psql -U <superuser> -d deviations -Atc "select (select count(*) from users) + (select count(*) from audit_log)"` → `0`.
   If it is not, note the rows in the change record, licence Deviations off, drop the `deviations` database and apply again.
4a. **Snapshot the platform databases before the move**: `deviations` (still empty) and `identity`, each with
   `plat exec -T db pg_dump -U <superuser> --format=custom <db> > /backups/pre-deviations-move-<db>.dump`, plus
   `sha256sum`. A rollback or the end of the rehearsal restores them.
5. **Dry run, then the move**, inside the Deviations image at the pinned commit, on the platform's network:
   ```sh
   export DEVIATIONS_COMMIT=$(jq -r .source.commit /opt/medhanta/current/apps/deviations/manifest.json)
   plat run --name deviations-move --no-deps \
     -e SOURCE_DATABASE_URL=postgres://<superuser>:<pw>@db:5432/deviations_move_source \
     -e PLATFORM_DATABASE_URL=postgres://<superuser>:<pw>@db:5432 \
     deviations node dist/db/move-to-platform.js --by <core admin login> \
     --verified-by "<who>" --verified-how "<how>" --link "<site-confirmed logins, comma-separated>" \
     --report /tmp/move.csv --dry-run
   docker cp deviations-move:/tmp/move.csv ./deviations-move-dry-run.csv && docker rm deviations-move
   ```
   Check the report's first rows: the site name and deviation count must be the **live** site's, not the demo's.
   Then the same without `--dry-run`, the report again to `/tmp/move.csv`, then
   `docker cp deviations-move:/tmp/move.csv ./deviations-move.csv && docker rm deviations-move`. Exit 0 and "moved"
   are required. A failed check writes nothing: both platform databases commit only after every check passed. They
   commit one after the other; should a commit itself fail, the report says "the move stopped", and the step-4a
   snapshot is restored before any new run. Keep both reports.
6. **Check on the platform** (as a moved QA person, with their own password):
   - sign in at `https://deviations.187-126-126-5.sslip.io`; open the deviation list, a closed deviation with its history
     and signatures (all valid), the CAPA register, and the batch lookup for a known batch;
   - run the integrity check (Audit screen): passed;
   - "Fetch related data" on a recent deviation: the Logbook part is read, Batchwright shows "not configured";
   - in core, the people screen shows the moved people with their Deviations permissions;
   - if the QMS is licensed: a CAPA number it references shows its status there.
7. **Records of the move**: the freeze dump and its SHA-256, the old site's integrity output, both move reports, the
   platform's integrity result, the checks of step 6, with times and names.
8. **Owner go / no-go.** On "no-go": rollback below.
9. **Switch.** Nothing to redirect: the platform already answers at the old name. Tell users. Remove the old
   `/etc/cron.d/deviations-live` lines (backups are now the platform's, PL-11). The app's own daily
   integrity check runs inside the platform Deviations as before. Drop the scratch database:
   `plat exec -T db dropdb -U <superuser> deviations_move_source`.

## Rollback

Until the owner signs off, the old installation (containers, database volume, `standalone` image) stays as it was at
the freeze. To go back: licence Deviations off in the config (apply stops it), start the old app (`old start app`),
give the name back to the old proxy entry. The old database is exactly as frozen, apart from the integrity check's own audit row. On the
platform: restore `deviations` and `identity` from the step-4a snapshot (drop and recreate each, then `pg_restore`
its dump as the superuser); that takes back the moved rows, people and grants, so the move can run again later.
Record the restore.

## After sign-off

Keep the old database volume and the freeze backup for the retention period; then remove the old containers. The
demo project is the owner's to keep or remove. The `standalone` branch stays as the record of the software that made
the old records.
