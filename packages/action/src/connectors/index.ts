// Connector barrel export.
//
// Provides the AtlaSent execution-authority connectors from a single import path:
//
//   import { webhookGuard, AgentGuard, agentGuard } from '@atlasent/action/connectors';
//
// These can also be imported from the package root:
//
//   import { webhookGuard, AgentGuard, agentGuard } from '@atlasent/action';
//
// NOTE: the Supabase-migration guard is intentionally NOT part of this
// published package yet — it couples to action-internal modules
// (canonicalAction, stateTransition) that the GitHub Action bundle also owns.
// Publishing it cleanly requires extracting those into a shared core package;
// tracked as a follow-up. The source remains in this repo's git history.

export type {
  WebhookPayload,
  WebhookGuardResult,
  WebhookPayloadExtractor,
  WebhookGuardConfig,
  WebhookRequest,
  WebhookResponse,
  WebhookNext,
  WebhookGuard,
} from './webhook';
export { webhookGuard } from './webhook';

export type {
  AgentTool,
  AgentCallContext,
  AgentGuardConfig,
  AgentGuardFactory,
} from './agent';
export { AgentGuard, AgentGuardError, agentGuard } from './agent';
