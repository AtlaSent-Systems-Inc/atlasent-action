// Phase B7 — connector barrel export.
//
// Provides all Phase B7 connectors from a single import path:
//
//   import { webhookGuard, AgentGuard, agentGuard } from '@atlasent/action/connectors';
//
// These can also be imported from the package root if the package.json
// exports map is configured:
//
//   import { webhookGuard, AgentGuard, agentGuard } from '@atlasent/action';

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
