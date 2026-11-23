#!/bin/sh
set -eu

umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
server_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_root=${FINGER_MEMORY_BACKUP_ROOT:-"$server_dir/backups"}
backup_dir=
confirmed=false
assume_yes=false
app_stopped=false
pre_restore_dir=
restore_complete=false

usage() {
  printf '%s\n' \
    'Usage: ./scripts/restore-server-data.sh --backup DIR --confirm finger-memory --yes'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup)
      if [ "$#" -lt 2 ]; then
        usage >&2
        exit 2
      fi
      backup_dir=$2
      shift 2
      ;;
    --confirm)
      if [ "$#" -lt 2 ]; then
        usage >&2
        exit 2
      fi
      if [ "$2" = "finger-memory" ]; then
        confirmed=true
      fi
      shift 2
      ;;
    --yes)
      assume_yes=true
      shift
      ;;
    --output-root)
      if [ "$#" -lt 2 ]; then
        usage >&2
        exit 2
      fi
      output_root=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$backup_dir" ] || [ "$confirmed" != true ] || [ "$assume_yes" != true ]; then
  usage >&2
  exit 2
fi
for command_name in docker gzip tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command_name" >&2
    exit 1
  fi
done
if [ ! -d "$backup_dir" ]; then
  printf 'Backup directory does not exist: %s\n' "$backup_dir" >&2
  exit 1
fi

backup_dir=$(CDPATH= cd -- "$backup_dir" && pwd)
for required_file in database.sql.gz content-data.tar.gz manifest.txt SHA256SUMS; do
  if [ ! -f "$backup_dir/$required_file" ]; then
    printf 'Backup is missing %s\n' "$required_file" >&2
    exit 1
  fi
done
if ! grep -qx 'backup_format=1' "$backup_dir/manifest.txt"; then
  printf 'Unsupported backup format.\n' >&2
  exit 1
fi
if ! grep -qx 'database_name=finger_memory' "$backup_dir/manifest.txt"; then
  printf 'Backup database does not match this Compose project.\n' >&2
  exit 1
fi
if ! grep -qx 'content_scope=content-data-volume-without-staging' "$backup_dir/manifest.txt"; then
  printf 'Backup content scope is not supported.\n' >&2
  exit 1
fi
for archive in "$backup_dir/database.sql.gz" "$backup_dir/content-data.tar.gz"; do
  if ! gzip -t "$archive"; then
    printf 'Backup archive integrity check failed: %s\n' "$archive" >&2
    exit 1
  fi
done
if ! tar -tzf "$backup_dir/content-data.tar.gz" >/dev/null; then
  printf 'Content volume archive is not a valid tar archive.\n' >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  if ! (cd "$backup_dir" && sha256sum -c SHA256SUMS >/dev/null); then
    printf 'Backup checksum verification failed.\n' >&2
    exit 1
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! (cd "$backup_dir" && shasum -a 256 -c SHA256SUMS >/dev/null); then
    printf 'Backup checksum verification failed.\n' >&2
    exit 1
  fi
else
  printf 'Neither sha256sum nor shasum is available.\n' >&2
  exit 1
fi

on_exit() {
  status=$?
  if [ "$restore_complete" != true ]; then
    if [ "$app_stopped" = true ]; then
      printf 'Restore did not complete. The application remains stopped.\n' >&2
    fi
    if [ -n "$pre_restore_dir" ]; then
      printf 'Pre-restore backup: %s\n' "$pre_restore_dir" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

cd "$server_dir"
printf 'Capturing a pre-restore backup...\n' >&2
pre_restore_dir=$("$script_dir/backup-server-data.sh" --output-root "$output_root")
printf 'Pre-restore backup: %s\n' "$pre_restore_dir" >&2

printf 'Stopping application before restore...\n' >&2
docker compose stop app >/dev/null
app_stopped=true

printf 'Restoring MySQL database...\n' >&2
gzip -dc "$backup_dir/database.sql.gz" | docker compose exec -T mysql sh -ec '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
    --user=root \
    --host=127.0.0.1 \
    --default-character-set=utf8mb4 \
    "$MYSQL_DATABASE"
'

printf 'Restoring content-data volume...\n' >&2
gzip -dc "$backup_dir/content-data.tar.gz" | docker compose run -T -i --rm --no-deps --entrypoint sh app -ec '
  set -eu
  content_root=/var/lib/finger-memory/content
  find "$content_root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar -xf - -C "$content_root"
'

printf 'Starting application and waiting for health...\n' >&2
docker compose up -d --wait --wait-timeout 120 app
docker compose exec -T app curl -fsS http://127.0.0.1:8080/actuator/health >/dev/null

restore_complete=true
app_stopped=false
printf 'Restore complete. Pre-restore backup: %s\n' "$pre_restore_dir"
