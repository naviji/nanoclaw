# Agent Harness Refactoring - Migration Guide

## Overview

The NanoClaw agent-runner has been refactored to support multiple AI agent implementations through dependency injection. This allows switching between Claude Code, Google Gemini, and other AI providers without changing the core orchestration logic.

## What Changed

### Architecture

**Before:**
- Single monolithic `index.ts` with hardcoded Claude Agent SDK calls
- Tight coupling to `@anthropic-ai/claude-agent-sdk`
- No way to use alternative AI providers

**After:**
- Abstract `AgentHarness` base class defining the agent interface
- Pluggable harness implementations (Claude Code, Gemini, etc.)
- Factory pattern for harness selection via environment variable
- Clean separation between orchestration and agent execution

### New Files

```
container/agent-runner/src/
├── agent-harness.ts           # Abstract base class
├── claude-code-harness.ts     # Claude Code implementation
├── gemini-cli-harness.ts      # Google Gemini implementation
├── index.ts                   # Refactored with DI
└── ipc-mcp-stdio.ts          # Unchanged (MCP server)
```

### Modified Files

- `container/agent-runner/package.json` - Added `@google/genai` dependency
- `container/Dockerfile` - Updated comment to reflect multi-agent support
- `container/agent-runner/src/index.ts` - Complete refactor with harness factory

## Usage

### Using Claude Code (Default)

No changes needed - Claude Code remains the default:

```bash
# .env file (or leave unset for default)
AGENT_HARNESS_TYPE=claude-code
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Using Google Gemini

Set the harness type and provide Gemini API key:

```bash
# .env file
AGENT_HARNESS_TYPE=gemini
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.0-flash-exp  # Optional
```

### Using Bob

Bob is a Gemini fork with the same API:

```bash
# .env file
AGENT_HARNESS_TYPE=bob
BOB_API_KEY=your-bob-key-here
BOB_MODEL=gemini-2.0-flash-exp  # Optional
```

Bob uses `.bob` folder for session storage (falls back to `.agents` if unavailable).

### Configuration in Host

The host process (`src/container-runner.ts`) passes environment variables to containers. To enable Gemini:

1. Add to your `.env` file:
   ```bash
   AGENT_HARNESS_TYPE=gemini
   GEMINI_API_KEY=your-key-here
   ```

2. The credential proxy will need updating to support Gemini (currently only supports Anthropic API)

3. Rebuild the container:
   ```bash
   cd container
   ./build.sh
   ```

## Backward Compatibility

✅ **Fully backward compatible** - If `AGENT_HARNESS_TYPE` is not set, defaults to `claude-code`

All existing functionality is preserved:
- Session continuity
- Tool execution (Bash, files, web)
- MCP integration
- Conversation archiving
- Agent teams
- Memory system (CLAUDE.md files)

## Feature Comparison

| Feature | Claude Code | Gemini CLI | Bob | Notes |
|---------|-------------|------------|-----|-------|
| Session Continuity | ✅ | ✅ | ✅ | All support session persistence |
| Streaming | ✅ | ✅ | ✅ | All support streaming responses |
| Tool Execution | ✅ | ❌ | ✅ | Bob now has full tool support |
| MCP Support | ✅ | ❌ | ✅ | Bob now supports MCP integration |
| Message Piping | ✅ | ⚠️ | ✅ | Bob has enhanced message piping |
| Bash Commands | ✅ | ❌ | ✅ | Bob can execute bash commands |
| File Operations | ✅ | ❌ | ✅ | Bob supports read/write/list |
| Web Access | ✅ | ❌ | ⚠️ | Bob has placeholder (needs API) |
| Agent Teams | ✅ | ❌ | ❌ | Not yet supported in Bob |
| CLAUDE.md Memory | ✅ | ⚠️ | ✅ | Bob loads CLAUDE.md files |
| Conversation Archive | ✅ | ❌ | ✅ | Bob archives conversations |
| Session Storage | `.claude/` | `.gemini-sessions/` | `.bob/` or `.agents/` | Different locations |

## Implementation Details

### AgentHarness Interface

```typescript
abstract class AgentHarness {
  // Initialize the harness (load credentials, create client)
  abstract initialize(): Promise<void>;
  
  // Run a query with the agent
  abstract runQuery(
    prompt: string,
    sessionId: string | undefined,
    containerInput: ContainerInput,
  ): Promise<{
    newSessionId?: string;
    lastMessageId?: string;
    closedDuringQuery: boolean;
  }>;
  
  // Push a follow-up message to active query
  abstract pushMessage(message: string): void;
  
  // End the current query
  abstract endQuery(): void;
  
  // Feature detection
  abstract supportsSessionContinuity(): boolean;
  abstract supportsStreaming(): boolean;
  
  // Cleanup
  abstract cleanup(): Promise<void>;
}
```

### Factory Pattern

```typescript
function createAgentHarness(
  containerInput: ContainerInput,
  mcpServerPath: string,
): AgentHarness {
  const harnessType = process.env.AGENT_HARNESS_TYPE || 'claude-code';
  
  switch (harnessType.toLowerCase()) {
    case 'bob':
      return new BobHarness(config);
    
    case 'gemini':
    case 'gemini-cli':
      return new GeminiCliHarness(config);
    
    case 'claude':
    case 'claude-code':
    default:
      return new ClaudeCodeHarness(config);
  }
}
```

## Testing

### Test Claude Code (Default)

```bash
# No changes needed
npm run dev
```

### Test Gemini

```bash
# Set environment
export AGENT_HARNESS_TYPE=gemini
export GEMINI_API_KEY=your-key-here

# Rebuild container
cd container && ./build.sh

# Run NanoClaw
npm run dev
```

### Verify Harness Selection

Check container logs for:
```
[agent-runner] Creating Gemini CLI harness
[gemini-cli] Initialized Gemini harness with model: gemini-2.0-flash-exp
```

## Known Limitations

### Bob Harness

Bob now has **feature parity** with Claude Code for most use cases:

✅ **Implemented Features:**
1. **Tool Execution** - Full support for Bash, file operations
2. **MCP Integration** - Scheduler and custom tools work
3. **Enhanced Message Piping** - Real-time message streaming
4. **Conversation Archiving** - Automatic archiving when sessions grow
5. **CLAUDE.md Memory** - Loads and uses memory files

⚠️ **Minor Limitations:**
- **Web Access** - Placeholder implementation (needs actual web search API)
- **Agent Teams** - Not yet implemented (future enhancement)

Bob is now suitable for:
- ✅ Complex workflows requiring tools
- ✅ Scheduled tasks with file access
- ✅ Multi-step agent orchestration
- ✅ All standard NanoClaw features
- ⚠️ Web search (needs API integration)
- ❌ Agent teams (not yet supported)

### Gemini CLI Harness

The Gemini CLI implementation remains **basic** and lacks:

1. **Tool Execution** - No Bash, file operations, or web access
2. **MCP Integration** - Scheduler tools won't work
3. **Limited Message Piping** - Messages added to history, not streamed
4. **No Conversation Archiving** - Pre-compact hooks not available
5. **Simpler Memory** - Only system prompt, no CLAUDE.md file loading

Gemini CLI is suitable for:
- ✅ Simple conversational tasks
- ✅ Text generation and analysis
- ✅ Basic Q&A
- ❌ Complex workflows requiring tools

### Credential Proxy

The current credential proxy (`src/credential-proxy.ts`) only supports Anthropic API. To use Gemini or Bob in production, you'll need to:

1. Update the proxy to handle Google AI API endpoints
2. Or bypass the proxy for Gemini/Bob (pass API key directly to container)

## Migration Checklist

If you have a customized NanoClaw installation:

- [ ] Review custom modifications to `container/agent-runner/src/index.ts`
- [ ] Test with `AGENT_HARNESS_TYPE=claude-code` (should work unchanged)
- [ ] If using Gemini or Bob, understand feature limitations
- [ ] Update credential proxy if needed for Gemini/Bob
- [ ] Rebuild container after pulling changes
- [ ] Test scheduled tasks (may not work with Gemini)
- [ ] Test tool usage (Bash, files, web) - won't work with Gemini/Bob

## Future Enhancements

Potential improvements to the harness system:

1. **Tool Abstraction Layer** - Unified tool interface for all harnesses
2. **MCP Bridge** - Generic MCP-to-function-calling adapter for non-MCP agents
3. **Session Converter** - Migrate sessions between harnesses
4. **Capabilities API** - Query what features a harness supports
5. **Fallback Chain** - Try multiple harnesses if one fails
6. **Per-Group Harness** - Different groups use different AI providers

## Adding New Harnesses

To add support for another AI provider:

1. Create `src/my-ai-harness.ts` extending `AgentHarness`
2. Implement all required methods
3. Add to factory in `index.ts`
4. Add dependencies to `package.json`
5. Update Dockerfile if needed (CLI tools, etc.)
6. Document limitations and configuration

See `container/agent-runner/AGENT_HARNESS_README.md` for detailed instructions.

## Support

For issues or questions:

1. Check logs for harness initialization errors
2. Verify environment variables are set correctly
3. Ensure container was rebuilt after changes
4. Review feature comparison table for limitations
5. Open an issue with harness type and error details

## Rollback

To rollback to the original implementation:

```bash
git checkout main -- container/agent-runner/src/index.ts
cd container && ./build.sh
```

The original functionality is preserved in `ClaudeCodeHarness`, so you can also just ensure `AGENT_HARNESS_TYPE` is unset or set to `claude-code`.