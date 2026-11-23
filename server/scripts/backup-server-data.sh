#!/bin/sh
set -eu

umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
server_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_root=${FINGER_MEMORY_BACKUP_ROOT:-"$server_dir/backups"}

usage() {
  printf '%s\n' 'Usage: ./scripts/backup-server-data.sh [--output-root DIR]'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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

for command_name in docker gzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command_name" >&2
    exit 1
  fi
done

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  printf 'Neither sha256sum nor shasum is available.\n' >&2
  exit 1
}

mkdir -p "$output_root"
chmod 700 "$output_root"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="finger-memory-$timestamp"
backup_dir="$output_root/$backup_name"
suffix=1
while [ -e "$backup_dir" ]; do
  backup_name="finger-memory-$timestamp-$suffix"
  backup_dir="$output_root/$backup_name"
  suffix=$((suffix + 1))
done

partial_dir="$output_root/.partial-$backup_name-$$"
cleanup() {
  if [ -d "$partial_dir" ]; then
    find "$partial_dir" -mindepth 1 -delete
    rmdir "$partial_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
mkdir "$partial_dir"

printf 'Backing up MySQL database...\n' >&2
cd "$server_dir"
docker compose exec -T mysql sh -ec '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump \
    --user=root \
    --host=127.0.0.1 \
    --single-transaction \
    --quick \
    --routines \
    --triggers \
    --events \
    --no-tablespaces \
    --set-gtid-purged=OFF \
    --default-character-set=utf8mb4 \
    "$MYSQL_DATABASE"
' > "$partial_dir/database.sql"
gzip -c "$partial_dir/database.sql" > "$partial_dir/database.sql.gz"
rm "$partial_dir/database.sql"

printf 'Backing up content-data volume...\n' >&2
docker compose run -T --rm --no-deps --entrypoint sh app -ec '
  tar \
    --exclude=./.staging \
    -C /var/lib/finger-memory/content \
    -czf - \
    .
' > "$partial_dir/content-data.tar.gz"

schema_version=$(docker compose exec -T mysql sh -ec '
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
    --user=root \
    --host=127.0.0.1 \
    --batch \
    --skip-column-names \
    "$MYSQL_DATABASE" \
    -e "SELECT version FROM flyway_schema_history WHERE success = 1 ORDER BY installed_rank DESC LIMIT 1"
')
schema_version=$(printf '%s' "$schema_version" | tr -d '\r\n')
if [ -z "$schema_version" ]; then
  printf 'Unable to read the Flyway schema version.\n' >&2
  exit 1
fi

{
  printf 'backup_format=1\n'
  printf 'created_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_name=finger_memory\n'
  printf 'flyway_schema_version=%s\n' "$schema_version"
  printf 'content_scope=content-data-volume-without-staging\n'
} > "$partial_dir/manifest.txt"

database_checksum=$(checksum_file "$partial_dir/database.sql.gz")
content_checksum=$(checksum_file "$partial_dir/content-data.tar.gz")
{
  printf '%s  database.sql.gz\n' "$database_checksum"
  printf '%s  content-data.tar.gz\n' "$content_checksum"
} > "$partial_dir/SHA256SUMS"

mv "$partial_dir" "$backup_dir"
trap - EXIT HUP INT TERM
printf 'Backup complete: %s\n' "$backup_dir" >&2
printf '%s\n' "$backup_dir"
