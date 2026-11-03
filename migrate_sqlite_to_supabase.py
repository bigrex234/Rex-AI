#!/usr/bin/env python3
"""
Rex Ai SQLite -> Supabase PostgreSQL migration.

Safe by default: without --apply, this script only inspects the SQLite source
and verifies that it can connect to Supabase. It does not write to PostgreSQL.

Run from the Rex Ai project root:
  /usr/local/bin/python3 migrate_sqlite_to_supabase.py
  /usr/local/bin/python3 migrate_sqlite_to_supabase.py --apply

DATABASE_URL can be set in the environment. If it is absent, the script asks
for the connection string using hidden input. Never commit that URL to GitHub.
"""
import argparse
import getpass
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg2
from psycopg2.extras import execute_values


TABLES = {
    "users": ["id", "email", "password_hash", "created_at"],
    "conversations": [
        "id", "title", "visitor_id", "created_at", "updated_at",
        "user_id", "is_pinned", "is_archived",
    ],
    "messages": ["id", "conversation_id", "role", "content", "created_at"],
}


DDL = """
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);

CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    title VARCHAR(150) NOT NULL DEFAULT 'New Chat',
    visitor_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE,
    updated_at TIMESTAMP WITHOUT TIME ZONE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ix_conversations_visitor_id ON conversations(visitor_id);
CREATE INDEX IF NOT EXISTS ix_conversations_user_id ON conversations(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_messages_conversation_id ON messages(conversation_id);
"""


def normalized_dsn(value: str) -> str:
    value = value.strip()
    if value.startswith("postgres://"):
        value = "postgresql://" + value[len("postgres://"):]
    parts = urlsplit(value)
    if parts.scheme not in ("postgresql", "postgresql+psycopg2"):
        raise ValueError("DATABASE_URL must start with postgresql://")
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault("sslmode", "require")
    return urlunsplit(( "postgresql", parts.netloc, parts.path, urlencode(query), parts.fragment))


def parse_datetime(value):
    if value is None or isinstance(value, datetime):
        return value
    value = str(value).strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        raise ValueError(f"Could not parse database timestamp: {value!r}")


def get_source_counts(sqlite_path: Path):
    source = sqlite3.connect(str(sqlite_path))
    source.row_factory = sqlite3.Row
    counts = {}
    for table in TABLES:
        counts[table] = source.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    return source, counts


def migrate(source, target, dry_run=False):
    source.row_factory = sqlite3.Row
    with target:
        with target.cursor() as cursor:
            if dry_run:
                cursor.execute("SELECT current_database(), current_user")
                db_name, db_user = cursor.fetchone()
                print(f"Supabase connection OK: database={db_name}, user={db_user}")
                for table in TABLES:
                    cursor.execute(
                        "SELECT to_regclass(%s)",
                        (f"public.{table}",)
                    )
                    print(f"Target table {table}: {'exists' if cursor.fetchone()[0] else 'will be created'}")
                return

            cursor.execute(DDL)
            migrated = {}
            for table, columns in TABLES.items():
                source_columns = {
                    row["name"] for row in source.execute(f"PRAGMA table_info({table})")
                }
                selected = [column for column in columns if column in source_columns]
                if "id" not in selected:
                    raise RuntimeError(f"Source table {table} has no id column.")
                rows = source.execute(
                    f"SELECT {', '.join(selected)} FROM {table} ORDER BY id"
                ).fetchall()

                if rows:
                    values = []
                    for row in rows:
                        record = []
                        for column in selected:
                            value = row[column]
                            if column in ("created_at", "updated_at"):
                                value = parse_datetime(value)
                            if column in ("is_pinned", "is_archived") and value is not None:
                                value = bool(value)
                            record.append(value)
                        values.append(tuple(record))

                    column_sql = ", ".join(selected)
                    placeholders = ", ".join(["%s"] * len(selected))
                    sql = (
                        f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders}) "
                        "ON CONFLICT (id) DO NOTHING"
                    )
                    cursor.executemany(sql, values)

                cursor.execute(f"SELECT COUNT(*) FROM {table}")
                target_count = cursor.fetchone()[0]
                migrated[table] = {"source": len(rows), "target_after": target_count}

            # Ensure PostgreSQL-generated IDs continue above the imported IDs.
            for table in TABLES:
                cursor.execute(
                    """
                    SELECT setval(
                        pg_get_serial_sequence(%s, 'id'),
                        GREATEST(COALESCE((SELECT MAX(id) FROM """ + table + """), 1), 1),
                        EXISTS (SELECT 1 FROM """ + table + """)
                    )
                    """,
                    (f"public.{table}",),
                )

            print("Migration transaction completed.")
            for table, result in migrated.items():
                print(
                    f"  {table}: source rows={result['source']}, "
                    f"target rows after import={result['target_after']}"
                )
            print("Existing IDs were preserved. Rows with IDs already present were not overwritten.")


def main():
    parser = argparse.ArgumentParser(description="Migrate Rex Ai SQLite data to Supabase PostgreSQL.")
    parser.add_argument("--sqlite", default="instance/rex_ai.db", help="Path to the existing SQLite database.")
    parser.add_argument("--apply", action="store_true", help="Actually create tables and copy rows. Default is a safe dry run.")
    args = parser.parse_args()

    sqlite_path = Path(args.sqlite).expanduser().resolve()
    if not sqlite_path.is_file():
        print(f"SQLite database not found: {sqlite_path}", file=sys.stderr)
        sys.exit(2)

    dsn = os.getenv("DATABASE_URL", "").strip()
    if not dsn:
        dsn = getpass.getpass("Paste Supabase DATABASE_URL (hidden input): ").strip()
    if not dsn:
        print("DATABASE_URL is required.", file=sys.stderr)
        sys.exit(2)

    try:
        dsn = normalized_dsn(dsn)
        source, counts = get_source_counts(sqlite_path)
        print(f"SQLite source: {sqlite_path}")
        for table, count in counts.items():
            print(f"  {table}: {count} rows")
        print("Mode:", "APPLY (writes to Supabase)" if args.apply else "DRY RUN (no database writes)")

        target = psycopg2.connect(dsn, connect_timeout=15)
        try:
            migrate(source, target, dry_run=not args.apply)
        finally:
            target.close()
            source.close()

        if not args.apply:
            print("\nDry run complete. Re-run with --apply only after reviewing the counts.")
    except Exception as exc:
        print(f"\nMigration failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
