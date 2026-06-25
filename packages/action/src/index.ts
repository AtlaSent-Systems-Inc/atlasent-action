// @atlasent/action — package root.
//
// Re-exports every execution-authority connector so consumers can import from
// the package root or the `./connectors` subpath:
//
//   import { webhookGuard, agentGuard, supabaseMigrationGuard } from '@atlasent/action';
//   import { webhookGuard, agentGuard, supabaseMigrationGuard } from '@atlasent/action/connectors';
export * from './connectors/index';
