use std::borrow::Cow;

#[cfg(windows)]
use sqlx::Row;
#[cfg(windows)]
use sqlx::SqlSafeStr;
use sqlx::migrate::Migrator;
use sqlx_sqlite::SqlitePool;

pub(crate) static STATE_MIGRATOR: Migrator = sqlx_macros::migrate!("./migrations");
pub(crate) static LOGS_MIGRATOR: Migrator = sqlx_macros::migrate!("./logs_migrations");
pub(crate) static GOALS_MIGRATOR: Migrator = sqlx_macros::migrate!("./goals_migrations");
pub(crate) static MEMORIES_MIGRATOR: Migrator = sqlx_macros::migrate!("./memory_migrations");
pub(crate) static QUEUE_MIGRATOR: Migrator = sqlx_macros::migrate!("./queue_migrations");
pub(crate) static THREAD_HISTORY_MIGRATOR: Migrator =
    sqlx_macros::migrate!("./thread_history_migrations");

/// Allow an older Codex binary to open a database that has already been
/// migrated by a newer binary running in parallel.
///
/// We intentionally ignore applied migration versions that are newer than the
/// embedded migration set. Known migration versions are still validated by
/// checksum, so this only relaxes the "database is ahead of me" case.
fn runtime_migrator(base: &'static Migrator) -> Migrator {
    Migrator {
        migrations: Cow::Borrowed(base.migrations.as_ref()),
        ignore_missing: true,
        locking: base.locking,
        no_tx: base.no_tx,
        table_name: base.table_name.clone(),
        create_schemas: base.create_schemas.clone(),
    }
}

/// Windows release builds historically embedded CRLF migration text, while a source checkout may
/// contain LF. Repair only checksums that exactly match the same embedded SQL with CRLF line endings;
/// every other mismatch remains untouched for SQLx to reject.
///
/// Never repairs a database in the official Codex app's `%USERPROFILE%\.codex`: those CRLF
/// checksums are the official app's own, and rewriting them stops it from starting
/// ("failed to initialize sqlite state runtime"). There SQLx rejects the mismatch instead.
#[cfg(windows)]
pub(crate) async fn repair_windows_migration_checksums(
    pool: &SqlitePool,
    migrator: &Migrator,
    db_path: &std::path::Path,
) -> anyhow::Result<()> {
    let user_profile = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    repair_windows_migration_checksums_for_profile(pool, migrator, db_path, user_profile.as_deref())
        .await
}

#[cfg(windows)]
pub(crate) async fn repair_windows_migration_checksums_for_profile(
    pool: &SqlitePool,
    migrator: &Migrator,
    db_path: &std::path::Path,
    user_profile: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    if is_official_codex_home_db(db_path, user_profile) {
        tracing::warn!(
            database = %db_path.display(),
            "skipping Windows migration checksum repair in the official Codex home"
        );
        return Ok(());
    }
    let table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !table_exists {
        return Ok(());
    }

    let applied = sqlx::query("SELECT version, checksum FROM _sqlx_migrations")
        .fetch_all(pool)
        .await?;
    let mut repairs = Vec::new();
    for row in applied {
        let version = row.try_get::<i64, _>("version")?;
        let stored = row.try_get::<Vec<u8>, _>("checksum")?;
        let Some(migration) = migrator
            .migrations
            .iter()
            .find(|migration| migration.version == version)
        else {
            continue;
        };
        if stored == migration.checksum.as_ref() {
            continue;
        }
        let windows_sql = migration
            .sql
            .as_str()
            .replace("\r\n", "\n")
            .replace('\n', "\r\n");
        let windows_migration = sqlx::migrate::Migration::new(
            migration.version,
            migration.description.clone(),
            migration.migration_type,
            sqlx::AssertSqlSafe(windows_sql).into_sql_str(),
            migration.no_tx,
        );
        if stored != windows_migration.checksum.as_ref() {
            return Ok(());
        }
        repairs.push((version, stored, migration.checksum.clone()));
    }

    let mut transaction = pool.begin().await?;
    for (version, old_checksum, new_checksum) in repairs {
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND checksum = ?")
            .bind(new_checksum.as_ref())
            .bind(version)
            .bind(old_checksum)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}

/// True when `db_path` sits directly in `<user_profile>\.codex`, the official Codex app's home.
#[cfg(windows)]
pub(crate) fn is_official_codex_home_db(
    db_path: &std::path::Path,
    user_profile: Option<&std::path::Path>,
) -> bool {
    let (Some(db_dir), Some(user_profile)) = (db_path.parent(), user_profile) else {
        return false;
    };
    let normalize = |path: &std::path::Path| {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase()
    };
    normalize(db_dir) == normalize(&user_profile.join(".codex"))
}

#[cfg(not(windows))]
pub(crate) async fn repair_windows_migration_checksums(
    _pool: &SqlitePool,
    _migrator: &Migrator,
    _db_path: &std::path::Path,
) -> anyhow::Result<()> {
    Ok(())
}

pub(crate) fn runtime_state_migrator() -> Migrator {
    runtime_migrator(&STATE_MIGRATOR)
}

pub(crate) fn runtime_logs_migrator() -> Migrator {
    runtime_migrator(&LOGS_MIGRATOR)
}

pub(crate) fn runtime_goals_migrator() -> Migrator {
    runtime_migrator(&GOALS_MIGRATOR)
}

pub(crate) fn runtime_memories_migrator() -> Migrator {
    runtime_migrator(&MEMORIES_MIGRATOR)
}

pub(crate) fn runtime_queue_migrator() -> Migrator {
    runtime_migrator(&QUEUE_MIGRATOR)
}

// The paginated history projector will call this when it takes ownership of opening the database.
#[allow(dead_code)]
pub(crate) fn runtime_thread_history_migrator() -> Migrator {
    runtime_migrator(&THREAD_HISTORY_MIGRATOR)
}

pub(crate) async fn repair_legacy_recency_migration_version(
    pool: &SqlitePool,
    migrator: &Migrator,
) -> anyhow::Result<()> {
    let Some(recency_migration) = migrator
        .migrations
        .iter()
        .find(|migration| migration.version == 39)
    else {
        return Ok(());
    };
    let migrations_table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !migrations_table_exists {
        return Ok(());
    }

    let legacy_recency_needs_repair = sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1
FROM _sqlx_migrations
WHERE version = ?
  AND checksum = ?
  AND NOT EXISTS (
      SELECT 1 FROM _sqlx_migrations WHERE version = ?
  )
        "#,
    )
    .bind(38_i64)
    .bind(recency_migration.checksum.as_ref())
    .bind(recency_migration.version)
    .fetch_optional(pool)
    .await?
    .is_some();
    if !legacy_recency_needs_repair {
        return Ok(());
    }

    sqlx::query(
        r#"
UPDATE _sqlx_migrations
SET version = ?, description = ?
WHERE version = ?
  AND checksum = ?
  AND NOT EXISTS (
      SELECT 1 FROM _sqlx_migrations WHERE version = ?
  )
        "#,
    )
    .bind(recency_migration.version)
    .bind(recency_migration.description.as_ref())
    .bind(38_i64)
    .bind(recency_migration.checksum.as_ref())
    .bind(recency_migration.version)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "migrations_tests.rs"]
mod tests;
