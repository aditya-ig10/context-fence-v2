import React from 'react';
import {
  FolderOpen, Github, AppWindow, BrainCircuit, HardDrive, Globe,
  Database, GitBranch, Search, Clock, Box, MessageSquare, Cloud, Map,
  Library, Flame, Trello, LayoutTemplate, Briefcase, ShieldAlert,
  Activity, CreditCard, Server, PenTool, Zap, Mail, Calendar,
  MessageCircle, BookOpen, Cpu, Terminal, GitMerge, Sun, DollarSign,
  Music, Youtube, FileCheck, Table, Radio, Layers, Code, Sparkles,
  Share2, FileText, Lock, FileCode, Wrench, Package,
} from 'lucide-react';

/**
 * Universal connector icon registry mapping connector names/IDs
 * from marketplace & local configurations to monochrome Lucide icons.
 */
const ICON_MAP: Record<string, React.ElementType> = {
  // Files & OS
  filesystem: FolderOpen,
  files: FolderOpen,
  fs: FolderOpen,
  file: FileText,
  pdf: FileCheck,
  'pdf-reader': FileCheck,
  csv: Table,
  'csv-excel': Table,
  excel: Table,

  // Dev & Git
  github: Github,
  git: GitBranch,
  gitlab: GitBranch,
  'dev-tools': Code,
  devtools: Code,
  everything: Box,
  openapi: Zap,
  context7: Library,
  terraform: Server,
  sentry: ShieldAlert,
  datadog: Activity,

  // Browsers & Web
  puppeteer: AppWindow,
  playwright: AppWindow,
  browser: AppWindow,
  chrome: AppWindow,
  fetch: Globe,
  firecrawl: Flame,
  web: Globe,

  // Search & AI
  'brave-search': Search,
  brave: Search,
  exa: Search,
  'exa-search': Search,
  tavily: Search,
  perplexity: Search,
  search: Search,
  'sequential-thinking': BrainCircuit,
  'sequential-thought': BrainCircuit,
  reasoning: BrainCircuit,
  memory: HardDrive,
  openai: Cpu,
  'openai-api': Cpu,
  anthropic: Sparkles,
  huggingface: Cpu,

  // Databases & Storage
  sqlite: Database,
  postgres: Database,
  postgresql: Database,
  mysql: Database,
  mongodb: Database,
  redis: Database,
  neon: Database,
  'neon-database': Database,
  supabase: Database,
  firebase: Database,
  airtable: Database,
  database: Database,
  db: Database,

  // Cloud & Infra
  docker: Box,
  kubernetes: Server,
  k8s: Server,
  vercel: Cloud,
  cloudflare: Cloud,
  aws: Cloud,
  'aws-s3': Cloud,
  s3: Cloud,
  'aws-kb': Cloud,
  'google-drive': Cloud,
  gdrive: Cloud,
  'google-maps': Map,
  maps: Map,

  // Productivity & Communication
  slack: MessageSquare,
  discord: MessageSquare,
  notion: Trello,
  linear: LayoutTemplate,
  jira: Trello,
  confluence: Briefcase,
  obsidian: Box,
  gmail: Mail,
  mail: Mail,
  calendar: Calendar,
  gcal: Calendar,
  twitter: MessageCircle,
  x: MessageCircle,
  reddit: MessageCircle,

  // Media & Utilities
  spotify: Music,
  youtube: Youtube,
  weather: Sun,
  currency: DollarSign,
  time: Clock,
  stripe: CreditCard,
  figma: PenTool,
  mermaid: GitMerge,
  arxiv: BookOpen,
  wikipedia: BookOpen,

  // Code Exec
  'python-repl': Terminal,
  python: Terminal,
  'js-repl': Terminal,
  javascript: Terminal,
  node: Terminal,
  shell: Terminal,
  bash: Terminal,
  terminal: Terminal,
};

/**
 * Normalizes an MCP server name or package string (e.g. '@modelcontextprotocol/server-filesystem')
 * into a matching key for the icon registry.
 */
export function normalizeConnectorKey(name: string): string {
  if (!name) return '';
  let cleaned = name.toLowerCase().trim();

  // Strip npm scope/prefix
  cleaned = cleaned.replace(/^@modelcontextprotocol\/server-/, '');
  cleaned = cleaned.replace(/^@[\w-]+\//, '');
  cleaned = cleaned.replace(/^mcp-server-/, '');
  cleaned = cleaned.replace(/-mcp-server$/, '');
  cleaned = cleaned.replace(/-mcp$/, '');
  cleaned = cleaned.replace(/^mcp-/, '');
  cleaned = cleaned.replace(/-server$/, '');

  // Strip special symbols and collapse
  cleaned = cleaned.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned;
}

/**
 * Returns the corresponding monochrome icon component for any connector name.
 * Defaults to `Cpu` or `Box` if no specific icon matches.
 */
export function getConnectorIcon(name: string): React.ElementType {
  if (!name) return Box;
  const rawKey = name.toLowerCase().trim();
  if (ICON_MAP[rawKey]) return ICON_MAP[rawKey];

  const normalized = normalizeConnectorKey(name);
  if (ICON_MAP[normalized]) return ICON_MAP[normalized];

  // Fuzzy substring matches
  for (const [key, Icon] of Object.entries(ICON_MAP)) {
    if (normalized.includes(key) || rawKey.includes(key)) {
      return Icon;
    }
  }

  // Sensible default fallback
  return Cpu;
}
