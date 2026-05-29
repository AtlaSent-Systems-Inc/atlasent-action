// State transition builders for atlasent-action.
//
// AtlaSent authorizes authority over a consequential state transition,
// not just a named action. Providing current_state and proposed_state
// enables state-aware evaluation: the control plane can reason about
// WHAT IS CHANGING, not just what action was requested.
//
// The richer the transition, the more precise the policy decision:
//   "deployment requested" → risk_class: high
//   "v1.2.3 → v1.2.4, 0 breaking changes, all tests green" → risk_class: medium
//   "v1.2.3 → v2.0.0, breaking API, migration required" → risk_class: critical

// ---------------------------------------------------------------------------
// Core types (mirrored from atlasent-api schema — keep in sync)
// ---------------------------------------------------------------------------

export interface StateSnapshot {
  description: string;
  attributes?: Record<string, unknown>;
}

export interface StateTransition {
  current_state: StateSnapshot;
  proposed_state: StateSnapshot;
}

// ---------------------------------------------------------------------------
// Deployment state transitions
// ---------------------------------------------------------------------------

export interface DeploymentTransitionOptions {
  service: string;
  environment: string;
  currentVersion?: string;
  proposedVersion?: string;
  /** Commit SHA being deployed */
  commitSha?: string;
  /** Number of breaking changes in the proposed version */
  breakingChanges?: number;
  /** Whether all CI checks passed */
  testsGreen?: boolean;
}

/**
 * Build a state transition for a production deployment.
 * Passes version, environment, and CI state to the evaluator for risk scoring.
 */
export function deploymentTransition(opts: DeploymentTransitionOptions): StateTransition {
  const {
    service,
    environment,
    currentVersion = "unknown",
    proposedVersion = "unknown",
    commitSha,
    breakingChanges,
    testsGreen,
  } = opts;

  return {
    current_state: {
      description: `${service} ${currentVersion} running in ${environment}`,
      attributes: {
        service,
        version: currentVersion,
        environment,
      },
    },
    proposed_state: {
      description: `${service} ${proposedVersion} deployed to ${environment}`,
      attributes: {
        service,
        version: proposedVersion,
        environment,
        ...(commitSha != null ? { commit_sha: commitSha } : {}),
        ...(breakingChanges != null ? { breaking_changes: breakingChanges } : {}),
        ...(testsGreen != null ? { tests_green: testsGreen } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Database migration state transitions
// ---------------------------------------------------------------------------

export interface MigrationTransitionOptions {
  database: string;
  environment: string;
  migrationName: string;
  /** SQL statements in the migration — used for destructive op detection */
  statements?: string[];
  /** Whether a backup was confirmed before migration */
  backupConfirmed?: boolean;
  /** Estimated number of rows affected */
  rowsAffected?: number;
}

/** Destructive SQL patterns that elevate risk_class to critical */
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bALTER\s+TABLE\b.+\bDROP\b/i,
];

/**
 * Detect whether SQL statements contain destructive operations.
 * Destructive migrations require elevated approval regardless of action_type.
 */
export function detectDestructiveStatements(statements: string[]): {
  hasDestructiveOps: boolean;
  matched: string[];
} {
  const matched: string[] = [];
  for (const stmt of statements) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(stmt)) {
        matched.push(stmt.trim().substring(0, 120));
        break;
      }
    }
  }
  return { hasDestructiveOps: matched.length > 0, matched };
}

/**
 * Build a state transition for a database migration.
 * Automatically detects destructive operations and surfaces them in proposed_state
 * so the evaluator can apply elevated risk scoring without manual intervention.
 */
export function migrationTransition(opts: MigrationTransitionOptions): StateTransition & {
  hasDestructiveOps: boolean;
  destructiveStatements: string[];
} {
  const { database, environment, migrationName, statements = [], backupConfirmed, rowsAffected } = opts;
  const { hasDestructiveOps, matched } = detectDestructiveStatements(statements);

  return {
    current_state: {
      description: `${database} schema at current state in ${environment}`,
      attributes: {
        database,
        environment,
        migration_pending: migrationName,
        ...(backupConfirmed != null ? { backup_confirmed: backupConfirmed } : {}),
      },
    },
    proposed_state: {
      description: hasDestructiveOps
        ? `${database} schema after DESTRUCTIVE migration ${migrationName} in ${environment}`
        : `${database} schema after migration ${migrationName} applied in ${environment}`,
      attributes: {
        database,
        environment,
        migration_applied: migrationName,
        destructive_ops: hasDestructiveOps,
        ...(matched.length > 0 ? { destructive_statements: matched } : {}),
        ...(rowsAffected != null ? { rows_affected: rowsAffected } : {}),
        ...(backupConfirmed != null ? { backup_confirmed: backupConfirmed } : {}),
      },
    },
    hasDestructiveOps,
    destructiveStatements: matched,
  };
}

// ---------------------------------------------------------------------------
// Agent tool call state transitions
// ---------------------------------------------------------------------------

export interface AgentToolTransitionOptions {
  toolName: string;
  agentId?: string;
  /** High-level description of what the tool will do */
  effect?: string;
  args?: Record<string, unknown>;
}

/**
 * Build a state transition for an agent tool call.
 * Used by AgentGuard when forwarding evaluation context.
 */
export function agentToolTransition(opts: AgentToolTransitionOptions): StateTransition {
  const { toolName, agentId, effect, args } = opts;
  const actor = agentId ? `agent:${agentId}` : "agent";

  return {
    current_state: {
      description: `${actor} has not yet called ${toolName}`,
      attributes: {
        tool_name: toolName,
        ...(agentId != null ? { agent_id: agentId } : {}),
        called: false,
      },
    },
    proposed_state: {
      description: effect ?? `${actor} calls ${toolName}`,
      attributes: {
        tool_name: toolName,
        ...(agentId != null ? { agent_id: agentId } : {}),
        called: true,
        ...(args != null ? { args_summary: Object.keys(args) } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Generic state transition builder for custom action types
// ---------------------------------------------------------------------------

/**
 * Build a freeform state transition when no typed builder applies.
 * Use this for custom action types not covered by the built-in builders.
 */
export function stateTransition(
  currentDescription: string,
  proposedDescription: string,
  options?: {
    currentAttributes?: Record<string, unknown>;
    proposedAttributes?: Record<string, unknown>;
  },
): StateTransition {
  return {
    current_state: {
      description: currentDescription,
      attributes: options?.currentAttributes,
    },
    proposed_state: {
      description: proposedDescription,
      attributes: options?.proposedAttributes,
    },
  };
}
