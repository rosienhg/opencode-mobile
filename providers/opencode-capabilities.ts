import type { ServerContract } from '@/lib/opencode/client';

// Which server-owned surfaces the connected contract exposes, plus the
// permission policy that backs the auto-approve toggle.

export type ServerCapabilities = {
  contract: ServerContract;
  fileSave: boolean;
  fileStatus: boolean;
  mcpOAuth: boolean;
  savedPermissions: boolean;
  autoApprove: boolean;
  promptDeliveryAvailable: boolean;
  mcpIntegrationId: boolean;
  contextMentions: boolean;
  shellCommand: boolean;
};

export function getServerCapabilities(contract: ServerContract): ServerCapabilities {
  if (contract === 'hermes') {
    // Hermes exposes none of the OpenCode-only surfaces. Everything app-side
    // (chat, approvals, clarify, skills) is served by the hermes-ios plugin.
    return {
      contract,
      fileSave: false,
      fileStatus: false,
      mcpOAuth: false,
      savedPermissions: false,
      autoApprove: false,
      promptDeliveryAvailable: false,
      mcpIntegrationId: false,
      contextMentions: false,
      shellCommand: false,
    };
  }
  const full = contract === 'v1';
  return {
    contract,
    fileSave: true,
    fileStatus: true,
    mcpOAuth: true,
    // Server-persisted "always allow" rules are a V2 surface.
    savedPermissions: !full,
    autoApprove: !full,
    promptDeliveryAvailable: !full,
    mcpIntegrationId: !full,
    // API-dependent composer surfaces are V2-only for now.
    contextMentions: !full,
    shellCommand: !full,
  };
}
