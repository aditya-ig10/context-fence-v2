export interface Agent {
  id: string; name: string; type: string; source: string;
  mcpCount?: number; mcpServers?: string[];
  dailyUsage?: { date: string; calls: number }[];
  last24h?: { slot: number; tokens: number }[];
  stats?: { totalCalls: number; totalTokens: number; avgTokensPerCall: number; dotEnvReads: number };
}
export interface Policy {
  id?: number; name: string; action: 'allow' | 'deny' | 'log';
  reason: string; methods?: string[]; tools?: string[]; custom?: boolean;
}
export interface DashboardStats {
  uptime: number; agents: number; servers: string[]; policies: number;
  calls: { total: number; blocked: number };
}

// ── Connector management (TestMCP redesign) ─────────────────────────────────

export interface AgentBinding {
  agentType: string;
  enabled: number;
  boundAt: string;
  protected: boolean;
}

export interface Connector {
  name: string;
  type: 'stdio' | 'http';
  url: string | null;
  command: string | null;
  connected: number;
  lastCheck: string | null;
  status: 'connected' | 'error' | 'needs-auth';
  envKeys: string[];
  envSet: boolean;
  missingEnv: string[];
  authType: 'none' | 'apikey' | 'bearer' | 'oauth2';
  headerNames: string[];
  hasCredentials: boolean;
  // OAuth authorization-code status — presence/expiry only, never tokens.
  oauth?: {
    configured: boolean;   // browser flow can run (authorization_url set)
    hasToken: boolean;
    hasRefreshToken: boolean;
    expiresAt: number | null;
    expired: boolean;
    reauth: boolean;       // authorization lost — offer Reauthorize
  };
  toolCount: number;
  boundAgents: AgentBinding[];
  callsToday: number;
  lastSync: string | null;
}

export interface ConnectorTool {
  name: string;
  schema: { description?: string; inputSchema?: unknown };
  lastSyncedAt: string;
  policy: { ruleName: string; action: 'allow' | 'deny' | 'log' } | null;
}

export interface ConnectorDetail {
  server: Connector;
  tools: ConnectorTool[];
  lastSync: string | null;
  stats: {
    today: number;
    blockedToday: number;
    hourly: { hour: number; decision: string; count: number }[];
  };
}

export interface DetectedConnector {
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  envKeys: string[];
  envSet: boolean;
  headerKeys: string[];
  headersSet: boolean;
}

export interface DetectedConnectorGroup {
  agentType: string;
  agentName: string;
  configPath: string;
  connectors: DetectedConnector[];
}
