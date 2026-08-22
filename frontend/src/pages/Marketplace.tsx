/**
 * MCP Marketplace — InsightHub design language.
 * One-click install, overwrite support, and installed MCPs section.
 */
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import {
  Search, Download, CheckCircle, Loader2, X, Star,
  FolderOpen, Github, AppWindow, BrainCircuit, HardDrive, Globe,
  Database, GitBranch, Clock, Box, MessageSquare, Cloud, Map,
  Library, Flame, Trello, LayoutTemplate, Briefcase, ShieldAlert,
  Activity, CreditCard, Server, PenTool, Zap, Mail, Calendar as CalendarIcon,
  MessageCircle, BookOpen, Cpu, Terminal, GitMerge, Sun, DollarSign,
  Music, Youtube, FileCheck, Table, Check
} from 'lucide-react';
import { notify } from '../components/Toasts';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';

/* ─── Catalog ───────────────────────────────────────────────────────────── */

interface McpEntry {
  id: string;
  name: string;
  description: string;
  longDesc: string;
  category: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  author: string;
  authorVerified?: boolean;
  stars: number;
  installs: number;
  tags: string[];
  icon: React.ElementType;
  accentColor: string;
  docsUrl?: string;
  isNew?: boolean;
  isFeatured?: boolean;
}

const CATALOG: McpEntry[] = [
  /* ── Official Anthropic servers ─────────────────────────────────── */
  { id: 'filesystem', name: 'Filesystem', description: 'Read, write, and manage files on your local machine.', longDesc: 'Full local filesystem access.', category: 'Files', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/'], author: 'Anthropic', authorVerified: true, stars: 5820, installs: 124000, tags: ['files', 'io', 'local'], icon: FolderOpen, accentColor: '#00a699', isFeatured: true },
  { id: 'github', name: 'GitHub', description: 'Search repos, manage issues, PRs, and read code via the GitHub API.', longDesc: 'Full GitHub API access.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], author: 'Anthropic', authorVerified: true, stars: 6430, installs: 161000, tags: ['github', 'git', 'code', 'issues'], icon: Github, accentColor: '#f59e0b', isFeatured: true },
  { id: 'puppeteer', name: 'Puppeteer', description: 'Control headless Chrome for web scraping and browser automation.', longDesc: 'Headless Chrome browser automation.', category: 'Browser', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], author: 'Anthropic', authorVerified: true, stars: 3900, installs: 87000, tags: ['browser', 'scraping'], icon: AppWindow, accentColor: '#6366f1', isFeatured: true },
  { id: 'sequential-thinking', name: 'Sequential Thinking', description: 'Structured multi-step reasoning for complex problem-solving.', longDesc: 'Enables agents to break complex problems into sequential steps.', category: 'Reasoning', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], author: 'Anthropic', authorVerified: true, stars: 3200, installs: 68000, tags: ['reasoning', 'logic'], icon: BrainCircuit, accentColor: '#8b5cf6' },
  { id: 'memory', name: 'Memory', description: 'Persistent knowledge base that survives across sessions.', longDesc: 'Gives agents a persistent key-value memory store.', category: 'Memory', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], author: 'Anthropic', authorVerified: true, stars: 3600, installs: 74000, tags: ['memory', 'persistence'], icon: HardDrive, accentColor: '#ec4899' },
  { id: 'fetch', name: 'Fetch', description: 'Retrieve web content — HTML, JSON, plain text — from any URL.', longDesc: 'HTTP fetching for agents.', category: 'Web', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], author: 'Anthropic', authorVerified: true, stars: 2900, installs: 58000, tags: ['web', 'http', 'fetch'], icon: Globe, accentColor: '#06b6d4' },
  { id: 'sqlite', name: 'SQLite', description: 'Full SQL access to a local SQLite database file.', longDesc: 'Complete SQLite database access.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db'], author: 'Anthropic', authorVerified: true, stars: 2100, installs: 44000, tags: ['database', 'sql'], icon: Database, accentColor: '#f97316' },
  { id: 'git', name: 'Git', description: 'Local Git operations — log, diff, status, commit, branch.', longDesc: 'Full local Git repository integration.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git', '--repository', '.'], author: 'Anthropic', authorVerified: true, stars: 2500, installs: 52000, tags: ['git', 'vcs', 'code'], icon: GitBranch, accentColor: '#22c55e' },
  { id: 'brave-search', name: 'Brave Search', description: 'Privacy-first real-time web search powered by the Brave API.', longDesc: 'Web search without tracking.', category: 'Search', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], author: 'Anthropic', authorVerified: true, stars: 1900, installs: 38000, tags: ['search', 'web'], icon: Search, accentColor: '#fb923c', isNew: true },
  { id: 'postgres', name: 'PostgreSQL', description: 'Safe read-only SQL queries against a PostgreSQL database.', longDesc: 'Connect agents to a PostgreSQL database for schema inspection and read-only data queries.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'], author: 'Anthropic', authorVerified: true, stars: 1800, installs: 36000, tags: ['postgres', 'sql', 'database'], icon: Database, accentColor: '#0ea5e9', isNew: true },
  { id: 'time', name: 'Time', description: 'Current time, date arithmetic, and timezone conversions.', longDesc: 'Provides accurate current time in any timezone.', category: 'Utilities', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-time'], author: 'Anthropic', authorVerified: true, stars: 1200, installs: 24000, tags: ['time', 'date', 'timezone'], icon: Clock, accentColor: '#94a3b8' },
  { id: 'everything', name: 'Everything', description: 'Reference server covering every MCP feature — ideal for testing.', longDesc: 'The kitchen-sink MCP server.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], author: 'Anthropic', authorVerified: true, stars: 1500, installs: 30000, tags: ['testing', 'reference'], icon: Box, accentColor: '#a78bfa' },
  { id: 'slack', name: 'Slack', description: 'Read channels, send messages, and manage Slack workspace data.', longDesc: 'Connect agents to Slack.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], author: 'Anthropic', authorVerified: true, stars: 1600, installs: 32000, tags: ['slack', 'messaging', 'team'], icon: MessageSquare, accentColor: '#4ade80' },
  { id: 'google-drive', name: 'Google Drive', description: 'Search, read, and download files from Google Drive.', longDesc: 'Access your Google Drive from agents.', category: 'Cloud', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gdrive'], author: 'Anthropic', authorVerified: true, stars: 1400, installs: 28000, tags: ['google', 'drive', 'cloud'], icon: Cloud, accentColor: '#3b82f6' },
  { id: 'google-maps', name: 'Google Maps', description: 'Geocoding, directions, places, and distance matrix.', longDesc: 'Full Google Maps Platform access.', category: 'Data', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], author: 'Anthropic', authorVerified: true, stars: 1200, installs: 24000, tags: ['maps', 'geocoding'], icon: Map, accentColor: '#4ade80' },
  { id: 'aws-kb', name: 'AWS Knowledge Base', description: 'Retrieve content from AWS Bedrock Knowledge Bases.', longDesc: 'Query Amazon Bedrock Knowledge Bases for RAG workflows.', category: 'Cloud', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval-server'], author: 'Anthropic', authorVerified: true, stars: 890, installs: 18000, tags: ['aws', 'bedrock', 'rag'], icon: Cloud, accentColor: '#f59e0b' },
  /* ── Microsoft ───────────────────────────────────────────────────── */
  { id: 'playwright', name: 'Playwright', description: 'Multi-browser automation — Chromium, Firefox, WebKit.', longDesc: 'Full Playwright browser automation.', category: 'Browser', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'], author: 'Microsoft', authorVerified: true, stars: 4100, installs: 92000, tags: ['browser', 'playwright', 'testing'], icon: AppWindow, accentColor: '#34d399', isFeatured: true },
  /* ── Community — major packages ──────────────────────────────────── */
  { id: 'context7', name: 'Context7', description: 'Live, versioned API docs and code examples from real sources.', longDesc: 'Resolves library names to live, versioned documentation.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], author: 'Upstash', stars: 3100, installs: 66000, tags: ['docs', 'api', 'context'], icon: Library, accentColor: '#f43f5e', isFeatured: true },
  { id: 'exa', name: 'Exa Search', description: 'AI-native semantic + keyword web search via the Exa API.', longDesc: 'AI-native web search with semantic understanding.', category: 'Search', type: 'stdio', command: 'npx', args: ['-y', 'exa-mcp-server'], author: 'Exa AI', stars: 1500, installs: 30000, tags: ['search', 'semantic', 'web'], icon: Search, accentColor: '#7c3aed', isNew: true },
  { id: 'firecrawl', name: 'Firecrawl', description: 'Crawl entire websites and extract clean structured content.', longDesc: 'Turn any website into clean markdown at scale.', category: 'Web', type: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'], author: 'Firecrawl', stars: 2300, installs: 48000, tags: ['crawling', 'scraping', 'web'], icon: Flame, accentColor: '#ef4444' },
  { id: 'notion', name: 'Notion', description: 'Read and write Notion pages, databases, and blocks.', longDesc: 'Full Notion workspace access.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], author: 'Notion', authorVerified: true, stars: 2100, installs: 42000, tags: ['notion', 'notes', 'productivity'], icon: Trello, accentColor: '#64748b' },
  { id: 'linear', name: 'Linear', description: 'Manage Linear issues, projects, and cycles from your agent.', longDesc: 'Full Linear issue tracker integration.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', '@linear/mcp-server'], author: 'Linear', authorVerified: true, stars: 1700, installs: 34000, tags: ['linear', 'issues', 'project'], icon: LayoutTemplate, accentColor: '#818cf8', isNew: true },
  { id: 'sentry', name: 'Sentry', description: 'Inspect errors, traces, and performance data from Sentry.', longDesc: 'Query Sentry for error events, stack traces, and performance spans.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server'], author: 'Sentry', authorVerified: true, stars: 980, installs: 20000, tags: ['errors', 'sentry', 'observability'], icon: ShieldAlert, accentColor: '#7c3aed', isNew: true },
  { id: 'datadog', name: 'Datadog', description: 'Query metrics, logs, and APM traces from Datadog.', longDesc: 'Full Datadog observability access.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', '@datadog/mcp-server'], author: 'Datadog', authorVerified: true, stars: 870, installs: 17400, tags: ['monitoring', 'metrics', 'apm'], icon: Activity, accentColor: '#7c2d12', isNew: true },
  { id: 'stripe', name: 'Stripe', description: 'Query customers, charges, subscriptions, and invoices.', longDesc: 'Read-safe Stripe integration.', category: 'Finance', type: 'stdio', command: 'npx', args: ['-y', 'stripe-mcp'], author: 'Stripe', authorVerified: true, stars: 1300, installs: 26000, tags: ['stripe', 'payments', 'billing'], icon: CreditCard, accentColor: '#6366f1', isNew: true },
  { id: 'redis', name: 'Redis', description: 'Get, set, and query keys in a Redis instance.', longDesc: 'Connect agents to Redis.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', 'redis-mcp'], author: 'Redis', stars: 980, installs: 19600, tags: ['redis', 'cache', 'kv'], icon: Database, accentColor: '#dc2626' },
  { id: 'mysql', name: 'MySQL', description: 'Run safe read-only SQL queries against a MySQL database.', longDesc: 'Connect agents to MySQL databases for schema inspection and safe, read-only SQL queries.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', 'mysql-mcp-server'], author: 'Community', stars: 760, installs: 15200, tags: ['mysql', 'sql', 'database'], icon: Database, accentColor: '#0284c7' },
  { id: 'mongodb', name: 'MongoDB', description: 'Query documents and collections in MongoDB Atlas or local.', longDesc: 'Full MongoDB read access.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', 'mongodb-mcp-server'], author: 'Community', stars: 840, installs: 16800, tags: ['mongodb', 'nosql', 'database'], icon: Database, accentColor: '#16a34a' },
  { id: 'jira', name: 'Jira', description: 'Search and manage Jira issues, boards, and sprints.', longDesc: 'Full Jira Cloud integration.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'], author: 'Community', stars: 1100, installs: 22000, tags: ['jira', 'issues', 'agile'], icon: Trello, accentColor: '#2563eb' },
  { id: 'confluence', name: 'Confluence', description: 'Search and read Confluence pages and spaces.', longDesc: 'Access your Confluence knowledge base.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'confluence-mcp'], author: 'Community', stars: 720, installs: 14400, tags: ['confluence', 'wiki', 'docs'], icon: Briefcase, accentColor: '#0ea5e9' },
  { id: 'docker', name: 'Docker', description: 'List containers, images, and inspect Docker resources.', longDesc: 'Docker runtime integration.', category: 'Infrastructure', type: 'stdio', command: 'npx', args: ['-y', 'docker-mcp'], author: 'Community', stars: 1400, installs: 28000, tags: ['docker', 'containers', 'devops'], icon: Box, accentColor: '#0284c7' },
  { id: 'kubernetes', name: 'Kubernetes', description: 'Inspect pods, services, and cluster resources via kubectl.', longDesc: 'Query Kubernetes clusters safely.', category: 'Infrastructure', type: 'stdio', command: 'npx', args: ['-y', 'k8s-mcp'], author: 'Community', stars: 1100, installs: 22000, tags: ['kubernetes', 'k8s', 'devops'], icon: Server, accentColor: '#326ce5', isNew: true },
  { id: 'vercel', name: 'Vercel', description: 'Inspect Vercel deployments, projects, and domain status.', longDesc: 'Full Vercel platform access.', category: 'Infrastructure', type: 'stdio', command: 'npx', args: ['-y', 'vercel-mcp'], author: 'Community', stars: 890, installs: 17800, tags: ['vercel', 'deployments', 'serverless'], icon: Cloud, accentColor: '#171717', isNew: true },
  { id: 'terraform', name: 'Terraform', description: 'Read Terraform state, plans, and resource configurations.', longDesc: 'Inspect Terraform managed infrastructure.', category: 'Infrastructure', type: 'stdio', command: 'npx', args: ['-y', 'terraform-mcp'], author: 'Community', stars: 680, installs: 13600, tags: ['terraform', 'iac', 'infra'], icon: Server, accentColor: '#7c3aed' },
  { id: 'figma', name: 'Figma', description: 'Read Figma designs, components, and file metadata.', longDesc: 'Access Figma design files programmatically.', category: 'Design', type: 'stdio', command: 'npx', args: ['-y', 'figma-mcp'], author: 'Community', stars: 1200, installs: 24000, tags: ['figma', 'design', 'ui'], icon: PenTool, accentColor: '#a259ff', isNew: true },
  { id: 'openapi', name: 'OpenAPI', description: 'Explore and call any REST API from an OpenAPI spec.', longDesc: 'Turn any OpenAPI/Swagger spec into callable MCP tools.', category: 'Dev Tools', type: 'stdio', command: 'npx', args: ['-y', 'openapi-mcp-server'], author: 'Community', stars: 960, installs: 19200, tags: ['openapi', 'rest', 'api'], icon: Zap, accentColor: '#34d399' },
  { id: 'tavily', name: 'Tavily', description: 'AI-optimized search results for research and retrieval.', longDesc: 'Tavily\'s search API is built for AI agents.', category: 'Search', type: 'stdio', command: 'npx', args: ['-y', 'tavily-mcp'], author: 'Tavily', stars: 1100, installs: 22000, tags: ['search', 'research', 'ai'], icon: Search, accentColor: '#7c3aed', isNew: true },
  { id: 'perplexity', name: 'Perplexity', description: 'Search and synthesize real-time web information with citations.', longDesc: 'Perplexity AI search — get synthesized, cited answers from real-time web data.', category: 'Search', type: 'stdio', command: 'npx', args: ['-y', 'perplexity-mcp'], author: 'Community', stars: 920, installs: 18400, tags: ['search', 'perplexity', 'citations'], icon: Search, accentColor: '#6366f1', isNew: true },
  { id: 'obsidian', name: 'Obsidian', description: 'Read and search your Obsidian notes vault.', longDesc: 'Access your Obsidian knowledge vault.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'obsidian-mcp'], author: 'Community', stars: 1300, installs: 26000, tags: ['obsidian', 'notes', 'pkm'], icon: Box, accentColor: '#7c3aed' },
  { id: 'gmail', name: 'Gmail', description: 'Read, search, and send email through the Gmail API.', longDesc: 'Full Gmail integration.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'gmail-mcp'], author: 'Community', stars: 1050, installs: 21000, tags: ['gmail', 'email', 'google'], icon: Mail, accentColor: '#dc2626' },
  { id: 'calendar', name: 'Google Calendar', description: 'Read and create Google Calendar events and schedules.', longDesc: 'Manage your Google Calendar from agents.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'gcal-mcp'], author: 'Community', stars: 890, installs: 17800, tags: ['calendar', 'google', 'scheduling'], icon: CalendarIcon, accentColor: '#16a34a' },
  { id: 'discord', name: 'Discord', description: 'Read channels, send messages, and manage Discord servers.', longDesc: 'Discord bot integration for agents.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'discord-mcp'], author: 'Community', stars: 780, installs: 15600, tags: ['discord', 'messaging', 'community'], icon: MessageSquare, accentColor: '#5865f2' },
  { id: 'twitter', name: 'Twitter / X', description: 'Search tweets, read timelines, and post to Twitter/X.', longDesc: 'Twitter/X API integration.', category: 'Social', type: 'stdio', command: 'npx', args: ['-y', 'twitter-mcp'], author: 'Community', stars: 850, installs: 17000, tags: ['twitter', 'x', 'social'], icon: MessageCircle, accentColor: '#0ea5e9' },
  { id: 'reddit', name: 'Reddit', description: 'Browse subreddits, posts, and comments from Reddit.', longDesc: 'Reddit API integration.', category: 'Social', type: 'stdio', command: 'npx', args: ['-y', 'reddit-mcp'], author: 'Community', stars: 640, installs: 12800, tags: ['reddit', 'social', 'community'], icon: MessageCircle, accentColor: '#ef4444' },
  { id: 'arxiv', name: 'arXiv', description: 'Search and read academic papers from arXiv.org.', longDesc: 'Academic research access.', category: 'Research', type: 'stdio', command: 'npx', args: ['-y', 'arxiv-mcp-server'], author: 'Community', stars: 720, installs: 14400, tags: ['arxiv', 'research', 'papers'], icon: BookOpen, accentColor: '#dc2626' },
  { id: 'wikipedia', name: 'Wikipedia', description: 'Search and read Wikipedia articles in any language.', longDesc: 'Wikipedia knowledge access.', category: 'Research', type: 'stdio', command: 'npx', args: ['-y', 'wikipedia-mcp'], author: 'Community', stars: 680, installs: 13600, tags: ['wikipedia', 'knowledge', 'research'], icon: BookOpen, accentColor: '#64748b' },
  { id: 'huggingface', name: 'Hugging Face', description: 'Search models, datasets, and spaces on Hugging Face Hub.', longDesc: 'Hugging Face Hub integration.', category: 'AI/ML', type: 'stdio', command: 'npx', args: ['-y', 'huggingface-mcp'], author: 'Community', stars: 890, installs: 17800, tags: ['huggingface', 'models', 'ai'], icon: Cpu, accentColor: '#f59e0b', isNew: true },
  { id: 'openai-api', name: 'OpenAI API', description: 'Call OpenAI models and inspect usage from your agent.', longDesc: 'Wraps the OpenAI API as MCP tools.', category: 'AI/ML', type: 'stdio', command: 'npx', args: ['-y', 'openai-mcp'], author: 'Community', stars: 1100, installs: 22000, tags: ['openai', 'gpt', 'ai'], icon: Cpu, accentColor: '#10b981', isNew: true },
  { id: 'python-repl', name: 'Python REPL', description: 'Execute Python code in a sandboxed interpreter.', longDesc: 'Run Python code from your agent in a persistent REPL session.', category: 'Code', type: 'stdio', command: 'npx', args: ['-y', 'python-mcp-repl'], author: 'Community', stars: 1400, installs: 28000, tags: ['python', 'repl', 'code'], icon: Terminal, accentColor: '#3b82f6' },
  { id: 'js-repl', name: 'JavaScript REPL', description: 'Execute JavaScript/Node.js code from your agent.', longDesc: 'Run Node.js/JavaScript code live from your agent.', category: 'Code', type: 'stdio', command: 'npx', args: ['-y', 'js-mcp-repl'], author: 'Community', stars: 820, installs: 16400, tags: ['javascript', 'node', 'repl'], icon: Terminal, accentColor: '#f59e0b' },
  { id: 'shell', name: 'Shell / Terminal', description: 'Run shell commands in a controlled terminal environment.', longDesc: 'Execute shell commands from your agent in a sandboxed terminal.', category: 'Code', type: 'stdio', command: 'npx', args: ['-y', 'shell-mcp'], author: 'Community', stars: 1600, installs: 32000, tags: ['shell', 'terminal', 'bash'], icon: Terminal, accentColor: '#22c55e' },
  { id: 'mermaid', name: 'Mermaid Diagrams', description: 'Render Mermaid diagram code into images and SVGs.', longDesc: 'Generate Mermaid diagrams.', category: 'Design', type: 'stdio', command: 'npx', args: ['-y', 'mermaid-mcp'], author: 'Community', stars: 580, installs: 11600, tags: ['mermaid', 'diagrams', 'charts'], icon: GitMerge, accentColor: '#10b981' },
  { id: 'weather', name: 'Weather', description: 'Real-time weather and forecasts for any location.', longDesc: 'Current conditions, hourly and 7-day forecasts, historical data, and severe weather alerts.', category: 'Data', type: 'stdio', command: 'npx', args: ['-y', 'weather-mcp'], author: 'Community', stars: 760, installs: 15200, tags: ['weather', 'forecast', 'location'], icon: Sun, accentColor: '#0ea5e9' },
  { id: 'currency', name: 'Currency Exchange', description: 'Real-time currency exchange rates and conversions.', longDesc: 'Fetch live exchange rates, convert between 170+ currencies, view historical rate trends.', category: 'Finance', type: 'stdio', command: 'npx', args: ['-y', 'currency-mcp'], author: 'Community', stars: 480, installs: 9600, tags: ['currency', 'exchange', 'finance'], icon: DollarSign, accentColor: '#16a34a' },
  { id: 'spotify', name: 'Spotify', description: 'Search and play music, manage playlists, read listening history.', longDesc: 'Spotify Web API integration.', category: 'Media', type: 'stdio', command: 'npx', args: ['-y', 'spotify-mcp'], author: 'Community', stars: 920, installs: 18400, tags: ['spotify', 'music', 'playback'], icon: Music, accentColor: '#1db954' },
  { id: 'youtube', name: 'YouTube', description: 'Search videos, read transcripts, and inspect channel data.', longDesc: 'YouTube Data API integration.', category: 'Media', type: 'stdio', command: 'npx', args: ['-y', 'youtube-mcp'], author: 'Community', stars: 860, installs: 17200, tags: ['youtube', 'video', 'transcripts'], icon: Youtube, accentColor: '#ef4444' },
  { id: 'pdf', name: 'PDF Reader', description: 'Extract text and structure from PDF documents.', longDesc: 'Parse and extract content from PDF files.', category: 'Files', type: 'stdio', command: 'npx', args: ['-y', 'pdf-mcp'], author: 'Community', stars: 1100, installs: 22000, tags: ['pdf', 'documents', 'extraction'], icon: FileCheck, accentColor: '#dc2626' },
  { id: 'csv', name: 'CSV / Excel', description: 'Parse, filter, and aggregate CSV and Excel files.', longDesc: 'Work with tabular data files.', category: 'Data', type: 'stdio', command: 'npx', args: ['-y', 'csv-mcp'], author: 'Community', stars: 890, installs: 17800, tags: ['csv', 'excel', 'spreadsheet'], icon: Table, accentColor: '#16a34a' },
  { id: 'aws-s3', name: 'AWS S3', description: 'List buckets, read, upload, and manage S3 objects.', longDesc: 'Full AWS S3 access.', category: 'Cloud', type: 'stdio', command: 'npx', args: ['-y', 'aws-s3-mcp'], author: 'Community', stars: 980, installs: 19600, tags: ['aws', 's3', 'storage'], icon: Cloud, accentColor: '#f59e0b' },
  { id: 'cloudflare', name: 'Cloudflare', description: 'Manage Cloudflare zones, DNS, Workers, and pages.', longDesc: 'Cloudflare API integration.', category: 'Infrastructure', type: 'stdio', command: 'npx', args: ['-y', 'cloudflare-mcp'], author: 'Cloudflare', authorVerified: true, stars: 760, installs: 15200, tags: ['cloudflare', 'dns', 'workers'], icon: Cloud, accentColor: '#f97316', isNew: true },
  { id: 'neon', name: 'Neon Database', description: 'Query and manage serverless Postgres on Neon.', longDesc: 'Serverless PostgreSQL on Neon.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', '@neondatabase/mcp-server-neon'], author: 'Neon', authorVerified: true, stars: 680, installs: 13600, tags: ['neon', 'postgres', 'serverless'], icon: Database, accentColor: '#22c55e', isNew: true },
  { id: 'supabase', name: 'Supabase', description: 'Query Supabase databases, auth, and storage.', longDesc: 'Full Supabase platform access.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', 'supabase-mcp'], author: 'Community', stars: 1100, installs: 22000, tags: ['supabase', 'postgres', 'auth'], icon: Database, accentColor: '#3ecf8e', isNew: true },
  { id: 'firebase', name: 'Firebase', description: 'Access Firestore, Realtime DB, and Firebase Auth.', longDesc: 'Firebase platform integration.', category: 'Database', type: 'stdio', command: 'npx', args: ['-y', 'firebase-mcp'], author: 'Community', stars: 880, installs: 17600, tags: ['firebase', 'firestore', 'auth'], icon: Database, accentColor: '#f97316' },
  { id: 'airtable', name: 'Airtable', description: 'Read, filter, and write to Airtable bases and tables.', longDesc: 'Full Airtable API access.', category: 'Productivity', type: 'stdio', command: 'npx', args: ['-y', 'airtable-mcp'], author: 'Community', stars: 780, installs: 15600, tags: ['airtable', 'database', 'spreadsheet'], icon: Database, accentColor: '#2563eb' },
];

const CATEGORIES = ['All', 'Files', 'Dev Tools', 'Browser', 'Database', 'Search', 'Web', 'Memory', 'Reasoning', 'Utilities', 'Productivity', 'Infrastructure', 'Cloud', 'Code', 'AI/ML', 'Research', 'Design', 'Data', 'Finance', 'Social', 'Media'];

/* ─── Animation variants ─────────────────────────────── */

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1 },
};

/* ─── Catalog card ───────────────────────── */

function McpCard({ 
  entry, 
  variants, 
  isInstalled,
  onInstallClick
}: { 
  entry: McpEntry; 
  variants?: Variants; 
  isInstalled: boolean;
  onInstallClick: (entry: McpEntry, overwrite: boolean) => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);

  const handleInstallClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isInstalled) {
      if (!window.confirm(`The server "${entry.name}" is already installed. Do you want to overwrite and reinstall it?`)) {
        return;
      }
    }

    setInstalling(true);
    await onInstallClick(entry, isInstalled);
    setInstalling(false);
    
    if (!isInstalled) {
      setJustInstalled(true);
      setTimeout(() => setJustInstalled(false), 2000);
    }
  };

  const IconComponent = entry.icon;

  return (
    <motion.div
      className="mk-card"
      variants={variants}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Top row */}
      <div className="mk-card-top">
        <div className="mk-card-emoji" style={{ background: `${entry.accentColor}18`, color: entry.accentColor }}>
          <IconComponent size={24} strokeWidth={1.5} />
        </div>
        <div className="mk-card-badges">
          {entry.isNew && <span className="mk-badge-new">New</span>}
          {entry.authorVerified && <span className="mk-badge-verified">✦</span>}
          {isInstalled && <span className="mk-badge-installed"><CheckCircle size={10} /> Installed</span>}
        </div>
      </div>

      {/* Identity */}
      <div className="mk-card-identity">
        <p className="mk-card-name">{entry.name}</p>
        <p className="mk-card-author">{entry.author}</p>
      </div>

      {/* Description */}
      <p className="mk-card-desc">{entry.description}</p>

      {/* Tags */}
      <div className="mk-card-tags">
        {entry.tags.slice(0, 3).map((t) => <span key={t} className="mk-tag">{t}</span>)}
      </div>

      {/* Footer */}
      <div className="mk-card-foot">
        <div className="mk-card-stats">
          <span><Star size={10} /> {entry.stars >= 1000 ? `${(entry.stars / 1000).toFixed(1)}k` : entry.stars}</span>
          <span><Download size={10} /> {entry.installs >= 1000 ? `${Math.round(entry.installs / 1000)}k` : entry.installs}</span>
        </div>
        <button 
          className={`mk-card-cta-btn ${isInstalled ? 'installed' : ''}`}
          onClick={handleInstallClick}
          disabled={installing || justInstalled}
        >
          {installing ? (
            <><Loader2 size={12} className="mk-spin" /> Installing...</>
          ) : justInstalled ? (
            <><Check size={12} /> Done</>
          ) : isInstalled ? (
            <><Download size={12} /> Reinstall</>
          ) : (
            <>Install <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg></>
          )}
        </button>
      </div>
    </motion.div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */

export default function Marketplace() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  
  const fetchServers = () => fetch('/api/servers').then(r => r.json());
  const { data: installedData, refresh: refreshInstalled } = useCachedFetch('servers', fetchServers);
  const installedServers = (installedData as any)?.servers?.filter((s: any) => !s.removed) || [];
  const installedServerNames = new Set(installedServers.map((s: any) => s.name));

  const featured = CATALOG.filter((m) => m.isFeatured);
  const totalInstalls = Math.round(CATALOG.reduce((s, m) => s + m.installs, 0) / 1000);
  const totalStars = Math.round(CATALOG.reduce((s, m) => s + m.stars, 0) / 1000);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return CATALOG.filter((m) => {
      const matchCat = category === 'All' || m.category === category;
      const matchQ = !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q)) || m.author.toLowerCase().includes(q) || m.category.toLowerCase().includes(q);
      return matchCat && matchQ;
    });
  }, [search, category]);

  const navigateTo = useNavigate();

  const handleDirectInstall = async (mcp: McpEntry, overwrite: boolean) => {
    try {
      if (overwrite) {
        await fetch(`/api/servers/${encodeURIComponent(mcp.id)}`, { method: 'DELETE' });
      }

      const body: Record<string, unknown> = { name: mcp.id, type: mcp.type };
      if (mcp.type === 'stdio') { body.command = mcp.command; body.args = mcp.args ?? []; }
      else { body.url = mcp.url; }
      
      const res = await fetch('/api/servers', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(body) 
      });
      
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          notify.error('Already Installed', `A server named "${mcp.id}" is already registered.`, {
            label: 'Overwrite',
            onClick: () => handleDirectInstall(mcp, true)
          });
        } else {
          notify.error('Install Failed', data.error || 'Failed to install server');
        }
        return;
      }

      // Sync tools in background
      fetch(`/api/servers/${encodeURIComponent(mcp.id)}/fetch`, { method: 'POST' }).catch(() => {});
      
      notify.success(`${mcp.name} installed`, 'MCP server registered successfully');
      refreshInstalled();
      invalidateCache((k) => k === 'servers' || k.startsWith('server:'));
    } catch (err) {
      notify.error('Install Failed', 'Could not reach the backend');
    }
  };

  return (
    <div className="mk-root">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="mk-head">
        <div>
          <h1 className="mk-heading">Marketplace</h1>
          <p className="mk-subhead">Discover, install, and manage MCP servers. All route through the Context Fence proxy automatically.</p>
        </div>
      </header>

      {/* ── KPI row (orange → teal → white — exact ag2 language) ─── */}
      <section className="mk-kpis">
        <div className="mk-kpi mk-kpi-orange">
          <p className="mk-kpi-label">MCP<br />Servers</p>
          <p className="mk-kpi-value">{CATALOG.length}</p>
          <p className="mk-kpi-sub">curated, one-click install</p>
        </div>
        <div 
          className="mk-kpi mk-kpi-teal" 
          style={{ cursor: 'pointer' }}
          onClick={() => navigateTo('/test-mcp')}
        >
          <p className="mk-kpi-label">Installed<br />MCPs</p>
          <p className="mk-kpi-value">{installedServers.length}</p>
          <p className="mk-kpi-sub">click to view details</p>
        </div>
        <div className="mk-kpi mk-kpi-white">
          <p className="mk-kpi-label">Total<br />Installs</p>
          <p className="mk-kpi-value">{totalInstalls}<span className="mk-kpi-unit">k</span></p>
          <p className="mk-kpi-sub">downloads across the ecosystem</p>
        </div>
      </section>

      {/* ── Featured — same section-title language as Connectors ─── */}
      <div>
        <div className="mk-section-head">
          <h2 className="mk-section-title">Featured</h2>
          <span className="mk-count">{featured.length}</span>
        </div>
        <div className="mk-featured-grid">
          {featured.map((m) => {
            const isInstalled = installedServerNames.has(m.id);
            const IconComponent = m.icon;
            return (
              <motion.div
                key={m.id}
                className="mk-featured-card"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="mk-featured-emoji" style={{ background: `${m.accentColor}18`, color: m.accentColor }}>
                  <IconComponent size={24} strokeWidth={1.5} />
                </div>
                <div className="mk-featured-body">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <p className="mk-featured-name">{m.name}</p>
                    {m.authorVerified && <span className="mk-badge-verified">✦</span>}
                  </div>
                  <p className="mk-featured-author">{m.author}</p>
                  <p className="mk-featured-desc">{m.description}</p>
                  <div className="mk-featured-stats">
                    <span><Star size={10} /> {(m.stars / 1000).toFixed(1)}k</span>
                    <span><Download size={10} /> {Math.round(m.installs / 1000)}k</span>
                    <span>{m.type}</span>
                  </div>
                </div>
                
                <button 
                  className={`mk-featured-cta-btn ${isInstalled ? 'installed' : ''}`}
                  onClick={() => handleDirectInstall(m, isInstalled)}
                >
                  {isInstalled ? 'Reinstall' : 'Install'}
                  {!isInstalled && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>}
                </button>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* ── Search + category filter ─────────────────────────────── */}
      <div className="mk-filter-bar">
        <div className="mk-search-wrap">
          <Search size={14} className="mk-search-icon" />
          <input className="mk-search" placeholder="Search by name, tag, or author…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button className="mk-search-clear" onClick={() => setSearch('')}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* ── Category pills ────────────────────────────────────────── */}
      <div className="mk-cats">
        {CATEGORIES.map((cat) => (
          <button key={cat} className={`mk-cat${category === cat ? ' active' : ''}`} onClick={() => setCategory(cat)}>
            {cat}
          </button>
        ))}
      </div>

      {/* ── Results header ────────────────────────────────────────── */}
      <div className="mk-section-head">
        <h2 className="mk-section-title">
          {search ? `Results for "${search}"` : category === 'All' ? 'All Servers' : category}
        </h2>
        <span className="mk-count">{filtered.length}</span>
      </div>

      {/* ── Grid ─────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="mk-empty">
          <div className="mk-empty-icon">
            <Search size={28} />
          </div>
          <p className="mk-empty-title">No results found</p>
          <p className="mk-empty-desc">Try a different search term or browse a different category.</p>
          <button className="mk-empty-reset" onClick={() => { setSearch(''); setCategory('All'); }}>Clear filters</button>
        </div>
      ) : (
        <motion.div className="mk-grid" variants={containerVariants} initial="hidden" animate="visible">
          {filtered.map((m) => (
            <McpCard 
              key={m.id} 
              entry={m} 
              variants={cardVariants} 
              isInstalled={installedServerNames.has(m.id)}
              onInstallClick={handleDirectInstall} 
            />
          ))}
        </motion.div>
      )}

      <style>{`
/* ─── Root & ambient glow (identical to ag2-root / ad-root) ─── */
.mk-root {
  position: relative;
  display: flex; flex-direction: column; gap: 20px;
  padding-bottom: 48px;
}
.mk-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(99, 102, 241, 0.05), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.06), transparent 65%);
}
.mk-root > * { position: relative; z-index: 1; }
:root[data-theme="dark"] .mk-root::before {
  background:
    radial-gradient(620px 480px at 10% 6%, rgba(99, 102, 241, 0.12), transparent 62%),
    radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.09), transparent 62%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .mk-root::before {
    background:
      radial-gradient(620px 480px at 10% 6%, rgba(99, 102, 241, 0.12), transparent 62%),
      radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.09), transparent 62%);
  }
}
@keyframes mkSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.mk-spin { animation: mkSpin 0.8s linear infinite; }

/* ─── Header (identical rhythm to ag2-head) ─────────────────── */
.mk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mk-heading { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.mk-subhead { font-size: 13px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
:root[data-theme="dark"] .mk-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .mk-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); } }

/* ─── KPI row (exact ag2-kpi sizing) ────────────────────────── */
.mk-kpis { display: grid; gap: 18px; grid-template-columns: 1fr 1fr 1fr; }
@media (max-width: 900px) { .mk-kpis { grid-template-columns: 1fr; } }
.mk-kpi {
  position: relative;
  border-radius: 26px;
  padding: 26px 28px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  display: flex; flex-direction: column; justify-content: space-between;
  min-height: 190px;
}
.mk-kpi-label {
  font-size: clamp(19px, 1.7vw, 23px); font-weight: 400;
  letter-spacing: -0.02em; line-height: 1.16;
  margin: 0; opacity: 0.96;
}
.mk-kpi-value {
  font-size: clamp(38px, 3.8vw, 48px); font-weight: 400;
  letter-spacing: -0.03em; line-height: 1.02; margin: 0;
  font-variant-numeric: tabular-nums;
}
.mk-kpi-unit { font-size: 0.45em; font-weight: 450; letter-spacing: -0.01em; margin-left: 2px; }
.mk-kpi-sub { font-size: 12.5px; font-weight: 550; margin: 6px 0 0; opacity: 0.78; }
.mk-kpi-orange { background: linear-gradient(160deg, #ff5163, #ff3144); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(255,49,68,0.28); }
.mk-kpi-teal   { background: linear-gradient(160deg, #43907f, #397e70); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(57,126,112,0.26); }
.mk-kpi-white  { background: var(--card-bg); border: 1px solid var(--card-border); }
.mk-kpi-white .mk-kpi-label { color: var(--text-muted); }
.mk-kpi-white .mk-kpi-value { color: var(--text-primary); }
.mk-kpi-white .mk-kpi-sub   { color: var(--text-secondary); opacity: 1; }
:root[data-theme="dark"] .mk-kpi-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
:root[data-theme="dark"] .mk-kpi-teal   { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
:root[data-theme="dark"] .mk-kpi-white  { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .mk-kpi-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
  :root:not([data-theme]) .mk-kpi-teal   { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
  :root:not([data-theme]) .mk-kpi-white  { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
}

/* ─── Section head ───────────────────────────────────────────── */
.mk-section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.mk-section-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.mk-count { font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-inset); padding: 3px 10px; border-radius: 100px; }

/* ─── Featured strip ─────────────────────────────────────────── */
.mk-featured-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
@media (max-width: 800px) { .mk-featured-grid { grid-template-columns: 1fr; } }
.mk-featured-card {
  position: relative;
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 26px; padding: 22px 24px;
  display: flex; align-items: flex-start; gap: 18px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  transition: all 300ms cubic-bezier(0.22,1,0.36,1);
}
.mk-featured-card:hover { transform: translateY(-3px); border-color: rgba(255,49,68,0.22); box-shadow: 0 16px 44px rgba(16,24,32,0.09); }
.mk-featured-emoji {
  width: 52px; height: 52px; border-radius: 16px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.mk-featured-body { flex: 1; min-width: 0; padding-right: 60px; }
.mk-featured-name { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.mk-featured-author { font-size: 11.5px; font-weight: 550; color: var(--text-muted); margin: 3px 0 7px; }
.mk-featured-desc { font-size: 12.5px; font-weight: 500; color: var(--text-secondary); margin: 0 0 10px; line-height: 1.5; }
.mk-featured-stats { display: flex; align-items: center; gap: 12px; }
.mk-featured-stats span { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--text-muted); }
.mk-featured-cta {
  position: absolute; top: 18px; right: 18px;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 700; color: var(--text-secondary);
  padding: 7px 13px; border-radius: 999px;
  background: var(--bg-inset); border: 1px solid var(--border-default);
}
.mk-featured-cta-btn {
  position: absolute; top: 18px; right: 18px;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 700; color: var(--accent-coral);
  padding: 7px 13px; border-radius: 999px;
  border: 1px solid rgba(255,49,68,0.2); background: rgba(255,49,68,0.06);
  opacity: 0; transform: translateX(-4px);
  cursor: pointer;
  transition: all 220ms cubic-bezier(0.22,1,0.36,1);
}
.mk-featured-card:hover .mk-featured-cta-btn { opacity: 1; transform: translateX(0); }
.mk-featured-cta-btn.installed {
  color: var(--text-secondary); border: 1px solid var(--border-default); background: var(--bg-inset);
}
.mk-featured-cta-btn:hover { background: rgba(255,49,68,0.12); }
.mk-featured-cta-btn.installed:hover { background: var(--border-strong); }

:root[data-theme="dark"] .mk-featured-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .mk-featured-card:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .mk-featured-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .mk-featured-card:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
}

/* ─── Filter bar ─────────────────────────────────────────────── */
.mk-filter-bar { display: flex; gap: 10px; }
.mk-search-wrap { flex: 1; position: relative; display: flex; align-items: center; }
.mk-search-icon { position: absolute; left: 13px; color: var(--text-muted); pointer-events: none; }
.mk-search {
  width: 100%; height: 40px;
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 999px; padding: 0 40px 0 40px;
  font: inherit; font-size: 13.5px; font-weight: 500; color: var(--text-primary);
  outline: none; box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  transition: border-color 180ms ease, box-shadow 180ms ease;
}
.mk-search::placeholder { color: var(--text-muted); }
.mk-search:focus { border-color: rgba(255,49,68,0.35); box-shadow: 0 0 0 3px rgba(255,49,68,0.08); }
.mk-search-clear {
  position: absolute; right: 10px;
  width: 24px; height: 24px; border-radius: 999px;
  border: none; cursor: pointer;
  background: var(--bg-inset); color: var(--text-muted);
  display: flex; align-items: center; justify-content: center;
  transition: all 160ms ease;
}
.mk-search-clear:hover { background: var(--border-default); color: var(--text-primary); }

/* ─── Category pills ─────────────────────────────────────────── */
.mk-cats {
  display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none;
  padding: 2px 0;
}
.mk-cats::-webkit-scrollbar { display: none; }
.mk-cat {
  display: inline-flex; align-items: center; height: 34px; padding: 0 14px;
  border-radius: 999px; border: 1px solid var(--card-border);
  background: var(--card-bg); color: var(--text-secondary);
  font: inherit; font-size: 12.5px; font-weight: 650;
  cursor: pointer; white-space: nowrap;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  transition: all 180ms ease;
}
.mk-cat:hover { border-color: var(--border-strong); color: var(--text-primary); }
.mk-cat.active { background: #111111; border-color: #111111; color: #ffffff; box-shadow: 0 4px 14px rgba(17,17,17,0.18); }
:root[data-theme="dark"] .mk-cat.active { background: #f2f5f9; border-color: #f2f5f9; color: #0a0d13; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .mk-cat.active { background: #f2f5f9; border-color: #f2f5f9; color: #0a0d13; } }

/* ─── Card grid ──────────────────────────────────────────────── */
.mk-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
@media (max-width: 780px) { .mk-grid { grid-template-columns: 1fr; } }

/* ─── Catalog card (mirrors ag2-agent structure exactly) ─────── */
.mk-card {
  position: relative;
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 22px 24px 0;
  overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  transition: all 300ms cubic-bezier(0.22,1,0.36,1);
}
.mk-card:hover { transform: translateY(-3px); border-color: rgba(255,49,68,0.22); box-shadow: 0 16px 44px rgba(16,24,32,0.09); }
:root[data-theme="dark"] .mk-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .mk-card:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .mk-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .mk-card:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
}
.mk-card-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.mk-card-emoji {
  width: 48px; height: 48px; border-radius: 14px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.mk-card-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.mk-card-identity { margin-bottom: 8px; }
.mk-card-name { font-size: 15.5px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.mk-card-author { font-size: 11.5px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
.mk-card-desc { font-size: 12.5px; font-weight: 500; color: var(--text-secondary); margin: 0 0 12px; line-height: 1.5; flex: 1; }
.mk-card-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 16px; }
.mk-tag {
  font-size: 10.5px; font-weight: 650; letter-spacing: 0.02em; text-transform: uppercase;
  color: var(--text-muted); background: var(--bg-inset);
  border-radius: 5px; padding: 2px 7px;
}
.mk-card-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin: 0 -24px; padding: 12px 24px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-inset);
  border-radius: 0 0 26px 26px;
  flex-shrink: 0;
}
.mk-card-stats { display: flex; align-items: center; gap: 12px; }
.mk-card-stats span { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--text-muted); }

/* One-click Install CTA */
.mk-card-cta-btn {
  display: flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 700; color: var(--accent-coral);
  padding: 5px 12px; border-radius: 999px;
  border: 1px solid rgba(255,49,68,0.2); background: rgba(255,49,68,0.06);
  opacity: 0; transform: translateX(-4px);
  cursor: pointer; font-family: inherit;
  transition: all 220ms cubic-bezier(0.22,1,0.36,1);
}
.mk-card:hover .mk-card-cta-btn { opacity: 1; transform: translateX(0); }
.mk-card-cta-btn:hover { background: rgba(255,49,68,0.12); }
.mk-card-cta-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.mk-card-cta-btn.installed {
  color: var(--text-secondary); border: 1px solid var(--border-default); background: transparent;
}
.mk-card-cta-btn.installed:hover { background: var(--border-strong); }

/* ─── Badges ─────────────────────────────────────────────────── */
.mk-badge-new {
  font-size: 9.5px; font-weight: 750; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 5px;
  background: rgba(6,182,212,0.1); border: 1px solid rgba(6,182,212,0.3); color: #0891b2;
}
.mk-badge-verified { font-size: 10px; color: var(--accent-coral); font-weight: 750; padding: 0 2px; }
.mk-badge-installed {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 9.5px; font-weight: 750; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 5px;
  background: rgba(18,138,109,0.08); border: 1px solid rgba(18,138,109,0.2); color: #128a6d;
}
:root[data-theme="dark"] .mk-badge-new { color: #22d3ee; background: rgba(6,182,212,0.12); border-color: rgba(6,182,212,0.35); }
:root[data-theme="dark"] .mk-badge-installed { color: var(--accent-teal); background: rgba(47,230,176,0.08); border-color: rgba(47,230,176,0.25); }
@media (prefers-color-scheme: dark) { 
  :root:not([data-theme]) .mk-badge-new { color: #22d3ee; background: rgba(6,182,212,0.12); border-color: rgba(6,182,212,0.35); } 
  :root:not([data-theme]) .mk-badge-installed { color: var(--accent-teal); background: rgba(47,230,176,0.08); border-color: rgba(47,230,176,0.25); }
}

/* ─── Empty state ────────────────────────────────────────────── */
.mk-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 72px 24px; background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 26px; text-align: center;
}
.mk-empty-icon {
  width: 56px; height: 56px; border-radius: 17px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  color: var(--text-muted); margin-bottom: 18px;
}
.mk-empty-title { font-size: 17px; font-weight: 650; color: var(--text-primary); margin: 0; letter-spacing: -0.01em; }
.mk-empty-desc { font-size: 13px; font-weight: 500; color: var(--text-muted); margin: 6px 0 20px; max-width: 30em; line-height: 1.55; }
.mk-empty-reset {
  display: inline-flex; align-items: center; height: 38px; padding: 0 18px;
  border-radius: 999px; border: 1px solid var(--border-default); background: var(--bg-inset);
  color: var(--text-secondary); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer;
  transition: all 160ms ease;
}
.mk-empty-reset:hover { border-color: var(--border-strong); color: var(--text-primary); }
      `}</style>
    </div>
  );
}
