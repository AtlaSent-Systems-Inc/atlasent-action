"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentGuard = exports.AgentGuardError = exports.AgentGuard = exports.webhookGuard = void 0;
var webhook_1 = require("./webhook");
Object.defineProperty(exports, "webhookGuard", { enumerable: true, get: function () { return webhook_1.webhookGuard; } });
var agent_1 = require("./agent");
Object.defineProperty(exports, "AgentGuard", { enumerable: true, get: function () { return agent_1.AgentGuard; } });
Object.defineProperty(exports, "AgentGuardError", { enumerable: true, get: function () { return agent_1.AgentGuardError; } });
Object.defineProperty(exports, "agentGuard", { enumerable: true, get: function () { return agent_1.agentGuard; } });
