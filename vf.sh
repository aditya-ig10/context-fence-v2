#!/bin/bash
echo '=== opencode.jsonc (mcp.servers) ==='
sed -n '/"mcp"/,/^[[:space:]]*}/p' ~/.config/opencode/opencode.jsonc 2>/dev/null | head -30
echo
echo '=== find context-fence.db ==='
DB=$(find / -name 'context-fence.db' 2>/dev/null | head -1)
echo "db=$DB"
cd /Users/aditya/Documents/GitHub/mcp-firewall/backend
node -e "
const d=require('better-sqlite3')(process.env.DB);
console.log('--- agent_connectors ---');
for(const r of d.prepare('SELECT agent_type,server_name,enabled FROM agent_connectors').all()) console.log(r.agent_type,'->',r.server_name,'enabled=',r.enabled);
console.log('--- mcp_servers (protected) ---');
for(const r of d.prepare(\"SELECT name,type,url,command FROM mcp_servers WHERE name IN ('playwright','sequential-thinking')\").all()) console.log(r.name, r.type, r.url, r.command);
"
