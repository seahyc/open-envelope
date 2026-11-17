import type Database from 'better-sqlite3';
import { applyTenancyV13 } from './tenancy-migration.js';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS raw_documents (
        hash TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        document_hash TEXT NOT NULL,
        account_hint TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        fx_amount_cents INTEGER,
        fx_currency TEXT,
        timestamp INTEGER NOT NULL,
        merchant_text TEXT NOT NULL,
        reference TEXT,
        kind TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (document_hash) REFERENCES raw_documents(hash)
      );

      CREATE INDEX IF NOT EXISTS idx_observations_document ON observations(document_hash);
      CREATE INDEX IF NOT EXISTS idx_observations_account ON observations(account_hint);
      CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp);

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL,
        account_group TEXT NOT NULL,
        opened_at INTEGER,
        closed_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        fx_amount_cents INTEGER,
        fx_currency TEXT,
        timestamp INTEGER NOT NULL,
        merchant_text TEXT NOT NULL,
        normalized_merchant TEXT,
        state TEXT NOT NULL,
        category TEXT,
        envelope_id TEXT,
        linked_transaction_id TEXT,
        observation_ids TEXT NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id),
        FOREIGN KEY (linked_transaction_id) REFERENCES transactions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_transactions_state ON transactions(state);

      CREATE TABLE IF NOT EXISTS statement_periods (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        start_date INTEGER NOT NULL,
        end_date INTEGER NOT NULL,
        opening_balance_cents INTEGER NOT NULL,
        closing_balance_cents INTEGER NOT NULL,
        document_hash TEXT,
        reconciled_at INTEGER,
        discrepancy_cents INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id),
        FOREIGN KEY (document_hash) REFERENCES raw_documents(hash)
      );

      CREATE INDEX IF NOT EXISTS idx_statement_periods_account ON statement_periods(account_id);

      CREATE TABLE IF NOT EXISTS merchant_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        category TEXT NOT NULL,
        envelope_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS envelopes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        monthly_target_cents INTEGER,
        color TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_allocations (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        month TEXT NOT NULL,
        allocated_cents INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (envelope_id) REFERENCES envelopes(id),
        UNIQUE(envelope_id, month)
      );

      CREATE INDEX IF NOT EXISTS idx_budget_allocations_month ON budget_allocations(month);

      CREATE TABLE IF NOT EXISTS adapter_configs (
        name TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        config TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_queue (
        id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT,
        resolved INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_review_queue_resolved 
      ON review_queue(resolved, created_at DESC);

      CREATE TABLE IF NOT EXISTS merchant_normalizations (
        id TEXT PRIMARY KEY,
        raw_merchant TEXT NOT NULL UNIQUE,
        normalized_name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_merchant_normalizations_raw
      ON merchant_normalizations(raw_merchant);
    `,
  },
  {
    version: 2,
    name: 'review_queue_document_hash',
    up: `
      CREATE TABLE IF NOT EXISTS review_queue (
        id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT,
        resolved INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_review_queue_resolved 
      ON review_queue(resolved, created_at DESC);

      CREATE TABLE IF NOT EXISTS merchant_normalizations (
        id TEXT PRIMARY KEY,
        raw_merchant TEXT NOT NULL UNIQUE,
        normalized_name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_merchant_normalizations_raw
      ON merchant_normalizations(raw_merchant);

      CREATE TABLE review_queue_new (
        id TEXT PRIMARY KEY,
        observation_id TEXT,
        document_hash TEXT,
        reason TEXT NOT NULL,
        detail TEXT,
        resolved INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      INSERT INTO review_queue_new (id, observation_id, reason, detail, resolved, created_at, resolved_at)
      SELECT id, observation_id, reason, detail, resolved, created_at, resolved_at
      FROM review_queue
      WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_queue');

      DROP TABLE IF EXISTS review_queue;
      ALTER TABLE review_queue_new RENAME TO review_queue;

      CREATE INDEX IF NOT EXISTS idx_review_queue_resolved 
      ON review_queue(resolved, created_at DESC);
      
      CREATE INDEX IF NOT EXISTS idx_review_queue_observation
      ON review_queue(observation_id) WHERE observation_id IS NOT NULL;
      
      CREATE INDEX IF NOT EXISTS idx_review_queue_document
      ON review_queue(document_hash) WHERE document_hash IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: 'ensure_normalized_merchant_column',
    up: `
      DROP TABLE IF EXISTS transactions_new;
      
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM pragma_table_info('transactions') 
          WHERE name = 'normalized_merchant'
        )
        THEN (
          SELECT 'ALTER TABLE transactions ADD COLUMN normalized_merchant TEXT'
        )
        ELSE 'SELECT 1'
      END as sql;
    `,
  },
  {
    version: 4,
    name: 'statement_import_flags',
    up: `
      ALTER TABLE observations ADD COLUMN is_statement INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE statement_periods ADD COLUMN status TEXT NOT NULL DEFAULT 'balanced';
    `,
  },
  {
    version: 5,
    name: 'pipeline_run_tables',
    up: `
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        document_hash TEXT,
        filename TEXT,
        adapter_name TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        observations_created INTEGER NOT NULL DEFAULT 0,
        transactions_created INTEGER NOT NULL DEFAULT 0,
        transactions_merged INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        flagged_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started
      ON pipeline_runs(started_at DESC);

      CREATE TABLE IF NOT EXISTS stage_runs (
        id TEXT PRIMARY KEY,
        pipeline_run_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        stage_version TEXT NOT NULL,
        adapter_name TEXT,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_count INTEGER NOT NULL DEFAULT 0,
        output_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        flagged_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_stage_runs_pipeline
      ON stage_runs(pipeline_run_id, started_at);
    `,
  },
  {
    version: 6,
    name: 'categoriser_memory',
    up: `
      CREATE TABLE IF NOT EXISTS merchant_memory (
        merchant_key TEXT NOT NULL,
        category_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        flag_ask INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (merchant_key, category_id)
      );

      CREATE TABLE IF NOT EXISTS category_exemplars (
        id TEXT PRIMARY KEY,
        merchant_key TEXT NOT NULL,
        account_id TEXT,
        amount_cents INTEGER NOT NULL,
        amount_band TEXT NOT NULL,
        memo TEXT,
        category_id TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_category_exemplars_category
      ON category_exemplars(category_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS category_exemplars_fts USING fts5(
        merchant_key,
        account_id,
        memo,
        amount_band,
        category_id UNINDEXED,
        exemplar_id UNINDEXED
      );
    `,
  },
  {
    version: 7,
    name: 'household_members',
    up: `
      CREATE TABLE IF NOT EXISTS household_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        email TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(name)
      );

      CREATE INDEX IF NOT EXISTS idx_household_members_name
      ON household_members(name);
    `,
  },
  {
    version: 8,
    name: 'review_undos',
    up: `
      CREATE TABLE IF NOT EXISTS review_undos (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_undos_created
      ON review_undos(created_at);
    `,
  },
  {
    version: 9,
    name: 'merchant_enrichments',
    up: `
      CREATE TABLE IF NOT EXISTS merchant_enrichments (
        merchant_key TEXT PRIMARY KEY,
        payee_name TEXT NOT NULL,
        uen TEXT,
        source TEXT NOT NULL,
        registered_name TEXT,
        entity_status TEXT,
        ssic_code TEXT,
        ssic_description TEXT,
        web_description TEXT,
        source_urls TEXT,
        fetched_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_merchant_enrichments_uen
      ON merchant_enrichments(uen);
    `,
  },
  {
    version: 10,
    name: 'context_signals',
    up: `
      CREATE TABLE IF NOT EXISTS location_devices (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        secret_salt TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );

      CREATE TABLE IF NOT EXISTS location_points (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        accuracy_m REAL,
        recorded_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        raw_json TEXT,
        FOREIGN KEY (member_id) REFERENCES household_members(id),
        FOREIGN KEY (device_id) REFERENCES location_devices(id)
      );
      CREATE INDEX IF NOT EXISTS idx_location_points_recorded
        ON location_points(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_location_points_member
        ON location_points(member_id, recorded_at);

      CREATE TABLE IF NOT EXISTS place_visits (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        arrived_at INTEGER NOT NULL,
        left_at INTEGER NOT NULL,
        place_name TEXT,
        place_source TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );
      CREATE INDEX IF NOT EXISTS idx_place_visits_member
        ON place_visits(member_id, arrived_at);

      CREATE TABLE IF NOT EXISTS geocode_cache (
        cache_key TEXT PRIMARY KEY,
        place_name TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS member_calendar_feeds (
        member_id TEXT PRIMARY KEY,
        ical_url_sealed TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );

      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_events_member
        ON calendar_events(member_id, starts_at);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        merchant TEXT NOT NULL,
        order_ref TEXT NOT NULL,
        member_id TEXT,
        total_cents INTEGER,
        currency TEXT NOT NULL DEFAULT 'SGD',
        ordered_at INTEGER,
        source_hash TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(merchant, order_ref),
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        name TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 1,
        unit_cents INTEGER,
        line_cents INTEGER,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS context_links (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        confidence REAL,
        snippet TEXT NOT NULL,
        proposed_split TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at INTEGER NOT NULL,
        UNIQUE(transaction_id, kind, source_id),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_context_links_tx
        ON context_links(transaction_id);

      CREATE TABLE IF NOT EXISTS spent_attributions (
        transaction_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        FOREIGN KEY (transaction_id) REFERENCES transactions(id),
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );
    `,
  },
  {
    version: 11,
    name: 'push_subscriptions',
    up: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 12,
    name: 'context_connections',
    up: `
      CREATE TABLE IF NOT EXISTS ingest_mailboxes (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL UNIQUE,
        local_part TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_received_at INTEGER,
        last_error TEXT,
        gmail_verify_code TEXT,
        gmail_verify_link TEXT,
        gmail_verify_at INTEGER,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ingest_mailboxes_local
        ON ingest_mailboxes(local_part);

      CREATE TABLE IF NOT EXISTS inbound_mail (
        id TEXT PRIMARY KEY,
        member_id TEXT,
        document_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_mail_received
        ON inbound_mail(received_at);
      CREATE INDEX IF NOT EXISTS idx_inbound_mail_member
        ON inbound_mail(member_id, received_at);

      CREATE TABLE IF NOT EXISTS extension_tokens (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        token_salt TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        last_error TEXT,
        revoked_at INTEGER,
        FOREIGN KEY (member_id) REFERENCES household_members(id)
      );
      CREATE INDEX IF NOT EXISTS idx_extension_tokens_member
        ON extension_tokens(member_id);

      ALTER TABLE member_calendar_feeds ADD COLUMN last_error TEXT;
      ALTER TABLE member_calendar_feeds ADD COLUMN last_fetched_at INTEGER;
      ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'email';
    `,
  },
  {
    version: 13,
    name: 'household_tenancy',
    up: `-- applied in applyTenancyV13 (ADD COLUMN + UNIQUE rebuilds)`,
  },
  {
    version: 14,
    name: 'auth_sessions_invites',
    up: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        name TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(email)
      );

      CREATE TABLE IF NOT EXISTS oauth_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(provider, provider_subject),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        household_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (household_id) REFERENCES households(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS magic_link_tokens (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_link_tokens(email, created_at);

      CREATE TABLE IF NOT EXISTS household_invites (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        email TEXT COLLATE NOCASE,
        token_hash TEXT NOT NULL UNIQUE,
        invited_by_member_id TEXT,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER,
        declined_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (household_id) REFERENCES households(id)
      );
      CREATE INDEX IF NOT EXISTS idx_invites_household ON household_invites(household_id);

      ALTER TABLE household_members ADD COLUMN user_id TEXT;
      ALTER TABLE household_members ADD COLUMN role TEXT NOT NULL DEFAULT 'partner';
    `,
  },
  {
    version: 15,
    name: 'payee_notes',
    up: `
      CREATE TABLE IF NOT EXISTS payee_notes (
        household_id TEXT NOT NULL,
        merchant_key TEXT NOT NULL,
        payee_label TEXT NOT NULL,
        project TEXT,
        category_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (household_id, merchant_key),
        FOREIGN KEY (household_id) REFERENCES households(id)
      );
      CREATE INDEX IF NOT EXISTS idx_payee_notes_household ON payee_notes(household_id);
    `,
  },
  {
    version: 16,
    name: 'ingest_hooks',
    up: `
      CREATE TABLE IF NOT EXISTS ingest_hooks (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        name TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        mapping TEXT,
        created_at INTEGER NOT NULL,
        last_received_at INTEGER,
        last_error TEXT,
        received_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_sample TEXT,
        FOREIGN KEY (member_id) REFERENCES household_members(id),
        FOREIGN KEY (household_id) REFERENCES households(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ingest_hooks_member
        ON ingest_hooks(household_id, member_id);

      CREATE TABLE IF NOT EXISTS ingest_hook_events (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        mapped_json TEXT,
        error TEXT,
        received_at INTEGER NOT NULL,
        UNIQUE(hook_id, event_key),
        FOREIGN KEY (hook_id) REFERENCES ingest_hooks(id),
        FOREIGN KEY (household_id) REFERENCES households(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ingest_hook_events_received
        ON ingest_hook_events(received_at);
      CREATE INDEX IF NOT EXISTS idx_ingest_hook_events_hook
        ON ingest_hook_events(hook_id, received_at);
    `,
  },
  {
    version: 17,
    name: 'merchant_enrichment_entity',
    up: `
      ALTER TABLE merchant_enrichments ADD COLUMN registered_address TEXT;
      ALTER TABLE merchant_enrichments ADD COLUMN incorporation_date TEXT;
    `,
  },
  {
    version: 18,
    name: 'alert_parse_confidence',
    up: `
      ALTER TABLE observations ADD COLUMN parse_confidence REAL;
      ALTER TABLE observations ADD COLUMN parse_method TEXT;
      ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_at INTEGER;
      ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_method TEXT;
      ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_confidence REAL;
      ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_status TEXT;
    `,
  },
];

export function runMigrations(
  db: Database.Database,
  options: { quiet?: boolean; throughVersion?: number } = {}
): void {
  const log = options.quiet ? () => {} : console.log;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const currentVersion = (db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number | null })?.version || 0;
  const cap = options.throughVersion ?? Number.POSITIVE_INFINITY;

  for (const migration of migrations) {
    if (migration.version > currentVersion && migration.version <= cap) {
      log(`[migrations] Applying migration ${migration.version}: ${migration.name}`);

      if (migration.version === 13) {
        // PRAGMA foreign_keys is a no-op inside a SQLite transaction; rebuilds need it off.
        db.pragma('foreign_keys = OFF');
        applyTenancyV13(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          Date.now()
        );
        db.pragma('foreign_keys = ON');
        log(`[migrations] Migration ${migration.version} applied successfully`);
        continue;
      }
      
      const applyMigration = db.transaction(() => {
        if (migration.version === 14) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              email TEXT NOT NULL COLLATE NOCASE,
              name TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(email)
            );
            CREATE TABLE IF NOT EXISTS oauth_accounts (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              provider_subject TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              UNIQUE(provider, provider_subject),
              FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              household_id TEXT,
              token_hash TEXT NOT NULL UNIQUE,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              last_seen_at INTEGER NOT NULL,
              FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
            CREATE TABLE IF NOT EXISTS magic_link_tokens (
              id TEXT PRIMARY KEY,
              email TEXT NOT NULL COLLATE NOCASE,
              token_hash TEXT NOT NULL UNIQUE,
              expires_at INTEGER NOT NULL,
              consumed_at INTEGER,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS household_invites (
              id TEXT PRIMARY KEY,
              household_id TEXT NOT NULL,
              email TEXT COLLATE NOCASE,
              token_hash TEXT NOT NULL UNIQUE,
              invited_by_member_id TEXT,
              expires_at INTEGER NOT NULL,
              accepted_at INTEGER,
              declined_at INTEGER,
              created_at INTEGER NOT NULL
            );
          `);
          const memberCols = db.prepare('PRAGMA table_info(household_members)').all() as Array<{ name: string }>;
          if (memberCols.length > 0 && !memberCols.some((c) => c.name === 'user_id')) {
            db.exec('ALTER TABLE household_members ADD COLUMN user_id TEXT');
          }
          if (memberCols.length > 0 && !memberCols.some((c) => c.name === 'role')) {
            db.exec("ALTER TABLE household_members ADD COLUMN role TEXT NOT NULL DEFAULT 'partner'");
          }
        } else if (migration.version === 3) {
          db.exec('DROP TABLE IF EXISTS transactions_new');
          
          const columns = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
          const hasColumn = columns.some(col => col.name === 'normalized_merchant');
          
          if (!hasColumn) {
            db.exec('ALTER TABLE transactions ADD COLUMN normalized_merchant TEXT');
          }
        } else if (migration.version === 18) {
          const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observations', 'ingest_mailboxes')"
          ).all() as Array<{ name: string }>;
          const tableNames = new Set(tables.map((row) => row.name));
          if (tableNames.has('observations')) {
            const columns = db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
            if (!columns.some((col) => col.name === 'parse_confidence')) {
              db.exec('ALTER TABLE observations ADD COLUMN parse_confidence REAL');
            }
            if (!columns.some((col) => col.name === 'parse_method')) {
              db.exec('ALTER TABLE observations ADD COLUMN parse_method TEXT');
            }
          }
          if (tableNames.has('ingest_mailboxes')) {
            const columns = db.prepare('PRAGMA table_info(ingest_mailboxes)').all() as Array<{ name: string }>;
            if (!columns.some((col) => col.name === 'last_parse_at')) {
              db.exec('ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_at INTEGER');
            }
            if (!columns.some((col) => col.name === 'last_parse_method')) {
              db.exec('ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_method TEXT');
            }
            if (!columns.some((col) => col.name === 'last_parse_confidence')) {
              db.exec('ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_confidence REAL');
            }
            if (!columns.some((col) => col.name === 'last_parse_status')) {
              db.exec('ALTER TABLE ingest_mailboxes ADD COLUMN last_parse_status TEXT');
            }
          }
        } else if (migration.version === 4) {
          const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observations', 'statement_periods')"
          ).all() as Array<{ name: string }>;
          const tableNames = new Set(tables.map((row) => row.name));

          if (tableNames.has('observations')) {
            const columns = db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
            if (!columns.some((col) => col.name === 'is_statement')) {
              db.exec('ALTER TABLE observations ADD COLUMN is_statement INTEGER NOT NULL DEFAULT 0');
            }
          }

          if (tableNames.has('statement_periods')) {
            const columns = db.prepare('PRAGMA table_info(statement_periods)').all() as Array<{ name: string }>;
            if (!columns.some((col) => col.name === 'status')) {
              db.exec("ALTER TABLE statement_periods ADD COLUMN status TEXT NOT NULL DEFAULT 'balanced'");
            }
          }
        } else {
          db.exec(migration.up);
        }
        
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          Date.now()
        );
      });
      
      applyMigration();
      log(`[migrations] Migration ${migration.version} applied successfully`);
    }
  }
}
