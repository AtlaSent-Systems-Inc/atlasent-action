// Supabase migration guard connector.
//
// Wraps Supabase migration execution with AtlaSent authorization.
// Before any migration runs, this guard:
//   1. Reads and parses the migration SQL
//   2. Detects destructive operations (DROP TABLE, TRUNCATE, DELETE FROM, etc.)
//   3. Evaluates against AtlaSent with full state transition context
//   4. Verifies the permit (fail-closed)
//   5. Returns { proceed: true, permit } on allow — caller runs the migration
//   6. Throws SupabaseMigrationGuardError on deny / hold / escalate / infra error
//
// Destructive migrations automatically use action_type "database.schema.drop"
// and carry destructive_statements in proposed_state — policies can apply
// elevated approval requirements without manual risk_class override.
//
// Usage:
//
//   import { supabaseMigrationGuard } from '@atlasent/action/connectors';
//   import { createClient } from '@supabase/supabase-js';
//
//   const guard = supabaseMigrationGuard({
//     apiKey: process.env.ATLASENT_API_KEY,
//     database: 'prod-db',
//     environment: 'production',
//   });
//
//   // Check — throws on deny/hold:
//   const { permit } = await guard.check({
//     migrationPath: './supabase/migrations/20260529_drop_users.sql',
//     backupConfirmed: true,
//   });
//
//   // Then run your migration:
//   const { error } = await supabase.rpc('run_migration', { sql: migrationSql });

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { evaluate, verify, verifyPermit, EnforceError } from '@atlasent/enforce';
import type { EnforceConfig } from '@atlasent/enforce';

import {
  DATABASE_MIGRATION_ACTION,
  DATABASE_SCHEMA_DROP_ACTION,
} from '../canonicalAction.js';
import {
  detectDestructiveStatements,
  migrationTransition,
} from '../stateTransition.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SupabaseMigrationGuardConfig {
  /** AtlaSent API key (ask_live_* or ask_test_*). */
  apiKey: string;
  /** Defaults to https://api.atlasent.io */
  apiUrl?: string;
  /** Database name forwarded to AtlaSent for state transition context. */
  database: string;
  /** Environment string (e.g. "production", "staging"). */
  environment: string;
  /**
   * Actor id making the request. Defaults to "ci:unknown".
   * In GitHub Actions workflows, pass the GitHub actor:
   *   actorId: `github:${process.env.GITHUB_ACTOR}`
   */
  actorId?: string;
  /**
   * When true (default), hold decisions block migration. When false, hold
   * decisions are passed through and the caller decides what to do.
   */
  blockOnHold?: boolean;
}

export interface MigrationCheckOptions {
  /**
   * Path to the migration SQL file. Either this or `sql` must be provided.
   * The file is read synchronously — call this before starting async migration.
   */
  migrationPath?: string;
  /**
   * Raw SQL content. Use when the SQL is already in memory.
   * `migrationName` should be set explicitly when using this form.
   */
  sql?: string;
  /**
   * Migration name used in state transition descriptions and audit records.
   * Defaults to the basename of `migrationPath`, or "inline-migration".
   */
  migrationName?: string;
  /** Whether a database backup was confirmed before this migration. */
  backupConfirmed?: boolean;
  /** Estimated number of rows affected (used in risk scoring). */
  rowsAffected?: number;
  /** Additional context forwarded to AtlaSent. */
  context?: Record<string, unknown>;
}

export interface MigrationCheckResult {
  /** The AtlaSent permit token. Pass to verifyPermit if you need re-verification. */
  permitToken: string;
  /** Evaluation id for the audit record. */
  evaluationId: string;
  /** The action type used — database.migration.apply or database.schema.drop. */
  actionType: string;
  /** Whether destructive SQL operations were detected. */
  hasDestructiveOps: boolean;
  /** The destructive statements found, if any. */
  destructiveStatements: string[];
}

/**
 * Thrown when AtlaSent denies, holds, or escalates a migration.
 * Also thrown on infrastructure failures (fail-closed).
 */
export class SupabaseMigrationGuardError extends Error {
  readonly decision: 'deny' | 'hold' | 'escalate' | 'error';
  readonly migrationName: string;
  readonly evaluationId?: string;
  readonly hasDestructiveOps: boolean;

  constructor(
    message: string,
    decision: 'deny' | 'hold' | 'escalate' | 'error',
    migrationName: string,
    hasDestructiveOps: boolean,
    evaluationId?: string,
  ) {
    super(message);
    this.name = 'SupabaseMigrationGuardError';
    this.decision = decision;
    this.migrationName = migrationName;
    this.evaluationId = evaluationId;
    this.hasDestructiveOps = hasDestructiveOps;
  }
}

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

export class SupabaseMigrationGuard {
  private readonly config: SupabaseMigrationGuardConfig;

  constructor(config: SupabaseMigrationGuardConfig) {
    this.config = config;
  }

  /**
   * Evaluate a migration against AtlaSent. Throws on deny/hold/escalate/error.
   * On success, returns a MigrationCheckResult. The caller is then responsible
   * for executing the migration — AtlaSent has authorized it, not run it.
   *
   * @throws SupabaseMigrationGuardError on any non-allow outcome.
   */
  async check(opts: MigrationCheckOptions): Promise<MigrationCheckResult> {
    const { config } = this;
    const blockOnHold = config.blockOnHold !== false;

    // Resolve SQL and migration name.
    let sql: string;
    let migrationName: string;

    if (opts.migrationPath) {
      try {
        sql = readFileSync(opts.migrationPath, 'utf-8');
      } catch (err) {
        throw new SupabaseMigrationGuardError(
          `Cannot read migration file "${opts.migrationPath}": ${err instanceof Error ? err.message : String(err)}`,
          'error',
          opts.migrationPath,
          false,
        );
      }
      migrationName = opts.migrationName ?? basename(opts.migrationPath);
    } else if (opts.sql) {
      sql = opts.sql;
      migrationName = opts.migrationName ?? 'inline-migration';
    } else {
      throw new SupabaseMigrationGuardError(
        'Either migrationPath or sql must be provided',
        'error',
        'unknown',
        false,
      );
    }

    // Parse SQL into statements (split on semicolons, ignoring empty lines).
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    // Detect destructive operations.
    const { hasDestructiveOps, matched: destructiveStatements } =
      detectDestructiveStatements(statements);

    // Build the state transition.
    const transition = migrationTransition({
      database: config.database,
      environment: config.environment,
      migrationName,
      statements,
      backupConfirmed: opts.backupConfirmed,
      rowsAffected: opts.rowsAffected,
    });

    // Destructive migrations use the more specific action type so policies
    // can apply elevated requirements (e.g. quorum approval, backup evidence)
    // without needing to inspect state transition attributes.
    const actionType = hasDestructiveOps
      ? DATABASE_SCHEMA_DROP_ACTION
      : DATABASE_MIGRATION_ACTION;

    const actorId = config.actorId ?? 'ci:unknown';

    const enforceConfig: EnforceConfig = {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      action: actionType,
      actor: actorId,
      environment: config.environment,
      context: {
        source: 'supabase-migration',
        resource: { type: 'database', id: config.database },
        current_state: transition.current_state,
        proposed_state: transition.proposed_state,
        migration_name: migrationName,
        database: config.database,
        has_destructive_ops: hasDestructiveOps,
        ...(destructiveStatements.length > 0
          ? { destructive_statements: destructiveStatements }
          : {}),
        ...(opts.backupConfirmed != null
          ? { backup_confirmed: opts.backupConfirmed }
          : {}),
        ...(opts.rowsAffected != null
          ? { rows_affected: opts.rowsAffected }
          : {}),
        ...opts.context,
      },
    };

    // Evaluate.
    let decision: Awaited<ReturnType<typeof evaluate>>;
    try {
      decision = await evaluate(enforceConfig);
    } catch (err) {
      if (err instanceof EnforceError) {
        throw new SupabaseMigrationGuardError(
          `AtlaSent infra error evaluating migration "${migrationName}": ${err.message}`,
          'error',
          migrationName,
          hasDestructiveOps,
        );
      }
      throw err;
    }

    // Non-allow outcomes.
    if (decision.decision === 'deny') {
      const destructiveNote = hasDestructiveOps
        ? ' (migration contains destructive operations)'
        : '';
      throw new SupabaseMigrationGuardError(
        `Migration "${migrationName}" denied${destructiveNote}: ${decision.denyReason ?? 'no reason provided'}`,
        'deny',
        migrationName,
        hasDestructiveOps,
        decision.evaluationId,
      );
    }

    if (decision.decision === 'escalate') {
      throw new SupabaseMigrationGuardError(
        `Migration "${migrationName}" escalated — manual review required`,
        'escalate',
        migrationName,
        hasDestructiveOps,
        decision.evaluationId,
      );
    }

    if (decision.decision === 'hold') {
      if (blockOnHold) {
        throw new SupabaseMigrationGuardError(
          `Migration "${migrationName}" on hold: ${decision.holdReason ?? 'awaiting approval'}`,
          'hold',
          migrationName,
          hasDestructiveOps,
          decision.evaluationId,
        );
      }
      // blockOnHold=false: caller decides — return a result with no permitToken.
      return {
        permitToken: '',
        evaluationId: decision.evaluationId ?? '',
        actionType,
        hasDestructiveOps,
        destructiveStatements,
      };
    }

    // Allow: verify the permit before returning (fail-closed).
    try {
      verify(decision);
      await verifyPermit(enforceConfig, decision);
    } catch (err) {
      if (err instanceof EnforceError) {
        throw new SupabaseMigrationGuardError(
          `AtlaSent permit verification failed for migration "${migrationName}": ${err.message}`,
          'error',
          migrationName,
          hasDestructiveOps,
          decision.evaluationId,
        );
      }
      throw err;
    }

    return {
      permitToken: decision.permitToken ?? '',
      evaluationId: decision.evaluationId ?? '',
      actionType,
      hasDestructiveOps,
      destructiveStatements,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export interface SupabaseMigrationGuardFactory {
  /** Evaluate and authorize a migration. Throws on deny/hold/escalate/error. */
  check(opts: MigrationCheckOptions): Promise<MigrationCheckResult>;
  /** The underlying SupabaseMigrationGuard instance. */
  readonly guard: SupabaseMigrationGuard;
}

/**
 * Create a Supabase migration guard from config.
 *
 * @example
 * const guard = supabaseMigrationGuard({
 *   apiKey: process.env.ATLASENT_API_KEY,
 *   database: 'prod-db',
 *   environment: 'production',
 *   actorId: `github:${process.env.GITHUB_ACTOR}`,
 * });
 *
 * const { hasDestructiveOps, actionType } = await guard.check({
 *   migrationPath: './supabase/migrations/20260529_add_index.sql',
 *   backupConfirmed: true,
 * });
 *
 * // guard.check() returned — migration is authorized. Run it.
 * await supabase.rpc('run_migration', { sql: readFileSync(path, 'utf-8') });
 */
export function supabaseMigrationGuard(
  config: SupabaseMigrationGuardConfig,
): SupabaseMigrationGuardFactory {
  const instance = new SupabaseMigrationGuard(config);
  return {
    guard: instance,
    check: (opts) => instance.check(opts),
  };
}
