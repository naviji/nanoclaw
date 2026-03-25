# Agent Selection Guide

NanoClaw supports multiple AI agent implementations through a pluggable harness system. You can choose which agent to use based on your needs and available API keys.

## Available Agents

### Claude Code (Default)
- **Provider**: Anthropic
- **Features**: Full feature set including tools, MCP, teams, memory
- **Authentication**: `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY` (pay-per-use)
- **Session Storage**: `.claude/`
- **Best For**: Production use, full NanoClaw features

### Bob
- **Provider**: Gemini-compatible (fork)
- **Features**: Full feature parity with Claude Code (tools, MCP, memory, archiving)
- **Authentication**: `BOBSHELL_API_KEY`
- **Session Storage**: `.bob/` (falls back to `.agents/`)
- **Best For**: Alternative to Claude, Gemini-compatible workflows

### Gemini CLI
- **Provider**: Google
- **Features**: Basic conversational AI (no tools, no MCP)
- **Authentication**: `GEMINI_API_KEY`
- **Session Storage**: `.gemini-sessions/`
- **Best For**: Simple Q&A, text generation

## Configuration

### Setting the Agent

Add to your `.env` file:

```bash
# Choose one:
AGENT_HARNESS_TYPE=claude-code  # Default
AGENT_HARNESS_TYPE=bob
AGENT_HARNESS_TYPE=gemini
```

### Authentication

Each agent requires its own API key:

```bash
# Claude Code (choose one)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # Subscription (Pro/Max)
ANTHROPIC_API_KEY=sk-ant-api03-...        # Pay-per-use

# Bob
BOBSHELL_API_KEY=your-bob-key-here
BOB_MODEL=gemini-2.0-flash-exp  # Optional

# Gemini
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.0-flash-exp  # Optional
```

### Session Storage

Each agent stores sessions in its own directory:

- **Claude Code**: `data/sessions/{group}/.claude/`
- **Bob**: `data/sessions/{group}/.bob/` (or `.agents/`)
- **Gemini**: `data/sessions/{group}/.gemini-sessions/`

Sessions are isolated per-group for security.

## Feature Comparison

| Feature | Claude Code | Bob | Gemini CLI |
|---------|-------------|-----|------------|
| Session Continuity | ✅ | ✅ | ✅ |
| Streaming | ✅ | ✅ | ✅ |
| Tool Execution | ✅ | ✅ | ❌ |
| MCP Support | ✅ | ✅ | ❌ |
| Bash Commands | ✅ | ✅ | ❌ |
| File Operations | ✅ | ✅ | ❌ |
| Web Access | ✅ | ⚠️ | ❌ |
| Agent Teams | ✅ | ❌ | ❌ |
| Memory (CLAUDE.md) | ✅ | ✅ | ⚠️ |
| Conversation Archive | ✅ | ✅ | ❌ |

✅ = Fully supported | ⚠️ = Partial support | ❌ = Not supported

## Memory Files

All agents support memory files, though with different capabilities:

- **CLAUDE.md**: Works with all agents (Claude Code, Bob, Gemini)
  - Claude Code: Full support with file loading
  - Bob: Full support with file loading
  - Gemini: System prompt only (no file loading)

The file is named `CLAUDE.md` for historical reasons, but it works with any agent.

## Switching Agents

To switch between agents:

1. Update `AGENT_HARNESS_TYPE` in `.env`
2. Ensure the corresponding API key is set
3. Rebuild the container: `cd container && ./build.sh`
4. Restart NanoClaw

Sessions are agent-specific and won't transfer between agents.

## Troubleshooting

### "Agent harness not initialized"
- Check that `AGENT_HARNESS_TYPE` is set correctly
- Verify the corresponding API key is present in `.env`

### "API key not found"
- Claude Code needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- Bob needs `BOBSHELL_API_KEY`
- Gemini needs `GEMINI_API_KEY`

### Sessions not resuming
- Each agent uses its own session directory
- Switching agents creates new sessions
- Check container logs in `groups/{folder}/logs/container-*.log`

### Tools not working (Bob/Gemini)
- Gemini CLI doesn't support tools
- Bob supports all tools (bash, files, MCP)
- Verify `AGENT_HARNESS_TYPE=bob` is set correctly

## Recommendations

- **Production**: Use Claude Code (most mature, full features)
- **Alternative**: Use Bob (full features, Gemini-compatible)
- **Simple tasks**: Use Gemini CLI (basic Q&A only)
- **Cost-sensitive**: Compare API pricing for your use case

## Getting API Keys

- **Claude**: https://console.anthropic.com/ or run `claude setup-token`
- **Bob**: Contact your Bob provider
- **Gemini**: https://makersuite.google.com/app/apikey