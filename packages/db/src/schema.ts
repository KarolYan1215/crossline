/**
 * Tables that once existed and never carried a row.
 *
 * Dropped at migration 4. Named here because a snapshot taken before that still lists them, and a
 * restore has to step over an empty one rather than refuse the whole backup — while still refusing
 * if one somehow has rows, because skipping those would be losing data quietly.
 */
/** Tables derived from others and rebuilt from them (migration 19's passages): not exported, skipped on restore, rebuilt after it. */
export const DERIVED_TABLES: readonly string[] = ["doc_chunks", "market_prices"];

export const RETIRED_TABLES = ["outbox", "identities", "projects", "milestone_versions", "insight_proposals", "skill_versions"] as const;

/** Columns a migration dropped, by table. Same reason as `RETIRED_TABLES`: old snapshots still list them. */
export const RETIRED_COLUMNS: Record<string, readonly string[]> = { energy_observations: ["expires_at"] };

/** The tables every ledger starts with; later columns, tables and indexes come from the migrations. */
export const LEDGER_SCHEMA = `
      CREATE TABLE IF NOT EXISTS settings (
        workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, key)
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, audit_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_attachments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        capture_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        file_name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, capture_id, uri)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(id, version)
      );
      CREATE TABLE IF NOT EXISTS milestone_relations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
        status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived')), updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL, project_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
        intent TEXT NOT NULL, state TEXT NOT NULL, risk_tier TEXT NOT NULL,
        estimate_json TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        pause_minutes INTEGER NOT NULL DEFAULT 0, outcome TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_claims (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, kind TEXT NOT NULL, uri TEXT NOT NULL,
        review_status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        source_refs_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, work_order_id, uri)
      );
      CREATE TABLE IF NOT EXISTS plan_versions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        version INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS energy_observations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        source TEXT NOT NULL, level TEXT NOT NULL, confidence TEXT NOT NULL,
        aggregate_json TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_bindings (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL, external_id TEXT NOT NULL, etag TEXT, sync_cursor TEXT,
        mode TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, provider, external_id)
      );
      CREATE TABLE IF NOT EXISTS capacity_commitments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, minimum_minutes INTEGER NOT NULL,
        source_task_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY, better_auth_user_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('viewer','member','owner')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(principal_id, workspace_id)
      );
      CREATE INDEX IF NOT EXISTS workspace_members_workspace ON workspace_members(workspace_id);
      CREATE TABLE IF NOT EXISTS tailscale_bindings (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        tailscale_login TEXT NOT NULL, node_key TEXT, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, tailscale_login)
      );
      CREATE TABLE IF NOT EXISTS device_leases (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        device_id TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
        UNIQUE(workspace_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS device_leases_workspace ON device_leases(workspace_id, device_id);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        role TEXT NOT NULL, auth_method TEXT NOT NULL, request_id TEXT NOT NULL,
        idempotency_key TEXT, codex_thread_id TEXT, codex_turn_id TEXT, codex_call_id TEXT,
        action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_workspace ON audit_events(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS duration_observations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        identity_id TEXT NOT NULL, family TEXT NOT NULL,
        observed_minutes INTEGER NOT NULL, wall_clock_minutes INTEGER NOT NULL, pause_minutes INTEGER NOT NULL,
        interruption_dominant INTEGER NOT NULL DEFAULT 0,
        baseline_p25_minutes INTEGER NOT NULL, baseline_p50_minutes INTEGER NOT NULL, baseline_p85_minutes INTEGER NOT NULL,
        observed_at TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, execution_id)
      );
      CREATE INDEX IF NOT EXISTS duration_observations_bucket ON duration_observations(workspace_id, identity_id, family, observed_at);
      CREATE TABLE IF NOT EXISTS assistant_threads (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        codex_thread_id TEXT, work_order_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_threads_workspace ON assistant_threads(workspace_id, updated_at);
      CREATE TABLE IF NOT EXISTS assistant_attachments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        file_name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, thread_id, uri)
      );
      CREATE INDEX IF NOT EXISTS assistant_attachments_thread ON assistant_attachments(workspace_id, thread_id);
      CREATE TABLE IF NOT EXISTS milestone_templates (
        id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('deliverable','threshold','validation','recurring_cadence','decision')),
        identity_id TEXT NOT NULL, title_hint TEXT NOT NULL,
        success_criteria_defaults_json TEXT NOT NULL, evidence_question_defaults_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('builtin','user','assistant')), created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS milestone_templates_identity ON milestone_templates(workspace_id, identity_id);
      CREATE TABLE IF NOT EXISTS workspace_projects (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, identity_id TEXT NOT NULL,
        name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','done','archived')),
        summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS workspace_projects_identity ON workspace_projects(workspace_id, identity_id);
      CREATE TABLE IF NOT EXISTS source_documents (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('pdf','docx','image','audio','text')),
        file_name TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL, uri TEXT NOT NULL,
        extracted_text TEXT NOT NULL DEFAULT '',
        extraction_status TEXT NOT NULL CHECK(extraction_status IN ('pending','done','failed','unsupported')),
        extraction_note TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, sha256)
      );
      CREATE TABLE IF NOT EXISTS onboarding_sessions (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, codex_thread_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('active','complete')), coverage_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS onboarding_messages (
        session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('assistant','user')), content_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS profile_facts (
        workspace_id TEXT NOT NULL, identity_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '',
        slot TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','inferred')),
        source_ref TEXT NOT NULL, source_quote TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, identity_id, project_id, slot)
      );
      CREATE TABLE IF NOT EXISTS waiting_items (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', expected_at TEXT NOT NULL, approximate INTEGER NOT NULL DEFAULT 0,
        follow_up_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','arrived','cancelled')),
        blocks_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS waiting_items_open ON waiting_items (workspace_id, state, follow_up_at);
      CREATE TABLE IF NOT EXISTS activity_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        app TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, idle INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS activity_segments_by_time ON activity_segments (workspace_id, end_at);
      CREATE INDEX IF NOT EXISTS activity_segments_by_start ON activity_segments (workspace_id, start_at, app);
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, skill TEXT NOT NULL, tier TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '', spend_mode TEXT NOT NULL DEFAULT 'normal',
        thread_id TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '', repairs INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_usage_by_time ON model_usage (workspace_id, at);
      CREATE TABLE IF NOT EXISTS milestone_anchors (
        workspace_id TEXT NOT NULL, milestone_id TEXT NOT NULL, stage INTEGER NOT NULL, deadline TEXT NOT NULL,
        baseline TEXT NOT NULL, target TEXT NOT NULL, stakeholders_json TEXT NOT NULL DEFAULT '[]',
        source_fact_ids_json TEXT NOT NULL DEFAULT '[]', depends_on_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, milestone_id)
      );
      CREATE TABLE IF NOT EXISTS diligence_reports (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        question TEXT NOT NULL, findings_json TEXT NOT NULL DEFAULT '[]', proposals_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')), note TEXT, run_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id)
      );
      -- A task's step graph (packages/core/src/steps.ts). The plan row says which archetype and how big; each step is scheduled on
      -- its own and carries its part of the task's progress. Replanning replaces the steps that are not done yet.
      CREATE TABLE IF NOT EXISTS task_step_plans (
        workspace_id TEXT NOT NULL, work_order_id TEXT NOT NULL, version INTEGER NOT NULL, archetype_id TEXT NOT NULL,
        quantity_json TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', planned_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, work_order_id)
      );
      CREATE TABLE IF NOT EXISTS task_steps (
        workspace_id TEXT NOT NULL, work_order_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
        title TEXT NOT NULL, deliverable TEXT NOT NULL DEFAULT '', done_criterion TEXT NOT NULL DEFAULT '', share REAL NOT NULL,
        p25_minutes INTEGER NOT NULL, p50_minutes INTEGER NOT NULL, p85_minutes INTEGER NOT NULL, depends_on_json TEXT NOT NULL DEFAULT '[]',
        not_before TEXT NOT NULL DEFAULT '', due_by TEXT NOT NULL DEFAULT '', schedulable INTEGER NOT NULL DEFAULT 1,
        executor TEXT NOT NULL DEFAULT 'human', tick_outcome TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','done','skipped')), progress_quarter INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, work_order_id, id)
      );
      -- What the system has learned about how this person wants things done (decided 2026-10-07): a correction told to the assistant,
      -- a milestone retrospective, an estimate or importance the person changed, a standard confirmed by hand, a relation turned down.
      -- Every later analysis, step plan and milestone design is given the live ones; the person can delete any of them in Settings.
      CREATE TABLE IF NOT EXISTS preference_entries (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1, ref_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, deleted_at TEXT,
        PRIMARY KEY(workspace_id, id)
      );
      -- Task archetypes the curator drew from this person's tasks and a public standard; offered to the step planner beside the
      -- built-in eighteen until the person retires one.
      CREATE TABLE IF NOT EXISTS learned_archetypes (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, archetype_json TEXT NOT NULL, basis_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, retired_at TEXT,
        PRIMARY KEY(workspace_id, id)
      );
`;
