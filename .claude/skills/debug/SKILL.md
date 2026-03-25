---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns container                      │ runs AI agent
    │ with volume mounts                   │ (Claude/Bob/Gemini)
    │                                      │ with MCP servers
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.{agent}/ ──> /home/node/.{agent}/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files are mounted to agent-specific directories:
- Claude Code: `/home/node/.claude/`
- Bob: `/home/node/.bob/` (or `.agents/`)
- Gemini: `/home/node/.gemini-sessions/`

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side messaging, routing, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Agent sessions** | `data/sessions/{group}/.{agent}/` | Agent-specific session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Agent process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Authentication failed
```
**Fix:** Ensure `.env` file exists with the correct API key for your agent:
```bash
cat .env  # Should show one of:
# Claude Code:
# AGENT_HARNESS_TYPE=claude-code
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)

# Bob:
# AGENT_HARNESS_TYPE=bob
# BOBSHELL_API_KEY=your-key-here

# Gemini:
# AGENT_HARNESS_TYPE=gemini
# GEMINI_API_KEY=AIza...
```

See `.claude/skills/AGENT_SELECTION.md` for details on agent configuration.

#### Root User Restriction (Claude Code only)
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

**Runtime note:** Environment variables passed via `-e` may be lost when using `-i` (interactive/piped stdin).

**Workaround:** The system extracts authentication variables from `.env` and mounts them for sourcing inside the container:
- `AGENT_HARNESS_TYPE`
- `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (Claude Code)
- `BOBSHELL_API_KEY`, `BOB_MODEL` (Bob)
- `GEMINI_API_KEY`, `GEMINI_MODEL` (Gemini)

To verify env vars are reaching the container:
```bash
echo '{}' | docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "Harness: $AGENT_HARNESS_TYPE"'
```

### 3. Mount Issues

**Container mount notes:**
- Docker supports both `-v` and `--mount` syntax
- Use `:ro` suffix for readonly mounts:
  ```bash
  # Readonly
  -v /path:/container/path:ro

  # Read-write
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (agent API keys, AGENT_HARNESS_TYPE)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Agent process exited with code 1"

If sessions aren't being resumed (new session ID every time), or the agent exits with code 1 when resuming:

**Root cause:** Each agent looks for sessions in its own directory. Inside the container, `HOME=/home/node`, so:
- Claude Code: `/home/node/.claude/`
- Bob: `/home/node/.bob/` (or `.agents/`)
- Gemini: `/home/node/.gemini-sessions/`

**Check the mount path:**
```bash
# In container-runner.ts, verify mount path matches your agent
grep -A3 "session" src/container-runner.ts
```

**Verify sessions are accessible (example for Claude Code):**
```bash
docker run --rm --entrypoint /bin/bash \
  -v ~/.claude:/home/node/.claude \
  nanoclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.claude/projects/ 2>&1 | head -5
'
```

**Fix:** Ensure `container-runner.ts` mounts to the correct agent directory:
```typescript
// Example for Claude Code
mounts.push({
  hostPath: claudeDir,
  containerPath: '/home/node/.claude',  // NOT /root/.claude
  readonly: false
});
```

**Note:** Sessions are agent-specific. Switching agents creates new sessions.

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test agent directly (Claude Code example):
```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  # For Claude Code:
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
  # For Bob/Gemini: agent runs via node, not CLI
'
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## Agent Configuration Reference

The agent-runner configures agents based on `AGENT_HARNESS_TYPE`:

### Claude Code Options
```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, Claude Code exits with code 1.

### Bob/Gemini Options
Bob and Gemini use function calling for tools. Configuration includes:
- System prompt with CLAUDE.md memory
- Tool definitions (bash, read_file, write_file, etc.)
- MCP tool integration (Bob only)
- Session management

See `container/agent-runner/src/bob-harness.ts` for implementation details.

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
docker builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
docker images

# Check what's in the image
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Agent runner ==="
  ls -la /app/dist/

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Agent sessions are stored per-group for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

**Session directories by agent:**
- Claude Code: `data/sessions/{group}/.claude/`
- Bob: `data/sessions/{group}/.bob/` (or `.agents/`)
- Gemini: `data/sessions/{group}/.gemini-sessions/`

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.{agent}/` (NOT `/root/.{agent}/`)

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group (adjust directory name for your agent)
rm -rf data/sessions/{groupFolder}/.claude/   # Claude Code
rm -rf data/sessions/{groupFolder}/.bob/      # Bob
rm -rf data/sessions/{groupFolder}/.gemini-sessions/  # Gemini

# Also clear the session ID from NanoClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

**Note:** Sessions are agent-specific. Switching agents creates new sessions.

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing messages to channels
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Agent configured?"
if [ -f .env ]; then
  if grep -q "AGENT_HARNESS_TYPE=" .env; then
    AGENT_TYPE=$(grep "AGENT_HARNESS_TYPE=" .env | cut -d= -f2)
    echo "Agent type: $AGENT_TYPE"
    case "$AGENT_TYPE" in
      claude-code)
        grep -q "CLAUDE_CODE_OAUTH_TOKEN=\|ANTHROPIC_API_KEY=" .env && echo "OK - Claude Code configured" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"
        ;;
      bob)
        grep -q "BOBSHELL_API_KEY=" .env && echo "OK - Bob configured" || echo "MISSING - add BOBSHELL_API_KEY"
        ;;
      gemini)
        grep -q "GEMINI_API_KEY=" .env && echo "OK - Gemini configured" || echo "MISSING - add GEMINI_API_KEY"
        ;;
      *)
        echo "UNKNOWN agent type: $AGENT_TYPE"
        ;;
    esac
  else
    echo "No AGENT_HARNESS_TYPE set, defaulting to claude-code"
    grep -q "CLAUDE_CODE_OAUTH_TOKEN=\|ANTHROPIC_API_KEY=" .env && echo "OK" || echo "MISSING - add authentication"
  fi
else
  echo "MISSING - .env file not found"
fi

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Container runtime running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING - start Docker Desktop (macOS) or sudo systemctl start docker (Linux)"

echo -e "\n4. Container image exists?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/\." src/container-runner.ts 2>/dev/null && echo "OK" || echo "CHECK - verify session mount path in container-runner.ts"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
