#!/bin/sh
# Daily backup of the deviation database (DV-22; 211.68(b), A11 7.2, SchM 20.9).
# Writes a pg_dump with a SHA-256 file, copies both to a second, off-host location (OFFSITE_DIR,
# e.g. a mounted network share or a separate disk), and removes backups older than KEEP_DAYS.
# Usage: DATABASE_URL=postgres://owner:pw@host/deviations BACKUP_DIR=/backups OFFSITE_DIR=/mnt/offsite ops/backup.sh
# Schedule daily, e.g. cron: 15 1 * * * /opt/deviations/ops/backup.sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-365}"
mkdir -p "$BACKUP_DIR"
name="deviations-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Dump to a temporary name; only a complete dump with its checksum gets the final name.
pg_dump --format=custom --no-owner --file="$BACKUP_DIR/$name.tmp" "$DATABASE_URL"
mv "$BACKUP_DIR/$name.tmp" "$BACKUP_DIR/$name"
# The checksum file names the dump without a path, so it verifies from inside either directory.
(cd "$BACKUP_DIR" && sha256sum "$name" > "$name.sha256")
if [ -n "${OFFSITE_DIR:-}" ]; then
  mkdir -p "$OFFSITE_DIR"
  cp "$BACKUP_DIR/$name" "$BACKUP_DIR/$name.sha256" "$OFFSITE_DIR/"
  # The copy is only trusted once it verifies against the checksum.
  (cd "$OFFSITE_DIR" && sha256sum -c --quiet "$name.sha256")
  find "$OFFSITE_DIR" -name 'deviations-*.dump*' -mtime +"$KEEP_DAYS" -delete
  echo "off-host copy verified: $OFFSITE_DIR/$name"
else
  echo "WARNING: OFFSITE_DIR is not set; the backup exists only on this host (DV-22 needs a second location)" >&2
fi
find "$BACKUP_DIR" -name 'deviations-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $BACKUP_DIR/$name"
