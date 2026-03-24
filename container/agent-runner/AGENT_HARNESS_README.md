# Agent Harness Architecture

This document describes the refactored agent-runner architecture that supports multiple AI agent implementations through dependency injection.

## Overview

The agent-runner has been refactored to support multiple agent harnesses (Claude Code, Gemini CLI, Bob, etc.) through a pluggable architecture. This allows NanoClaw to work with different AI providers without changing the core orchestration logic.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     index.ts (Main Entry)                    │
│  - Reads stdin for ContainerInput                            │
│  - Creates appropriate AgentHarness via factory              │
│  - Manages IPC polling and message piping                    │
│  - Streams results to stdout                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              AgentHarness (Abstract Base Class)              │
│  - initialize()                                              │
│  - runQuery(prompt, sessionId, containerInput)               │
│  - pushMessage(message)                                      │
│  - endQuery()                                                │
│  - supportsSessionContinuity()                               │
│  - supportsStreaming()                                       │
│  - cleanup()                                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│  ClaudeCodeHarness        │   │  GeminiCliHarness         │   │  BobHarness               │
│  - Uses Claude Agent SDK  │   │  - Uses @google/genai     │   │  - Uses @google/genai     │
│  - Full tool support      │   │  - Basic query/response   │   │  - Gemini fork            │
│  - MCP integration        │   │  - Custom session storage │   │  - .bob/.agents storage   │
│  - Session continuity     │   │  - Streaming support      │   │  - Streaming support      │
│  - Conversation archiving │   │  - Simpler tool model     │   │  - Same as Gemini         │
└───────────────────────────┘   └───────────────────────────┘   └───────────────────────────┘
```

## Files

### Core Files

- **`agent-harness.ts`** - Abstract base class defining the agent interface
- **`claude-code-harness.ts`** - Claude Code implementation (original functionality)
- **`gemini-cli-harness.ts`** - Google Gemini implementation
- **`bob-harness.ts`** - Bob implementation (Gemini fork)
- **`index.ts`** - Main entry point with harness factory and IPC management

### Supporting Files

- **`ipc-mcp-stdio.ts`** - MCP server for NanoClaw tools (scheduler, messaging)
- **`package.json`** - Dependencies (includes both Claude SDK and Gemini SDK)

## Configuration

The agent harness is selected via the `AGENT_HARNESS_TYPE` environment variable:

```bash
# Use Claude Code (default)
AGENT_HARNESS_TYPE=claude-code

# Use Gemini CLI
AGENT_HARNESS_TYPE=gemini

# Use Bob
AGENT_HARNESS_TYPE=bob
```

### Claude Code Configuration

Claude Code uses the existing credential proxy pattern:

```bash
# API Key mode
ANTHROPIC_API_KEY=sk-ant-api03-...

# OAuth mode
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

### Gemini Configuration

Gemini requires a Google AI API key:

```bash
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.0-flash-exp  # Optional, defaults to gemini-2.0-flash-exp
```

### Bob Configuration

Bob is a Gemini fork and requires a Bob API key:

```bash
BOB_API_KEY=your-bob-key-here
BOB_MODEL=gemini-2.0-flash-exp  # Optional, defaults to gemini-2.0-flash-exp
```

Bob uses `.bob` folder for session storage (falls back to `.agents` if `.bob` is unavailable).

## Agent Harness Interface

### Methods

#### `initialize(): Promise<void>`
Initialize the harness (load credentials, create client, etc.)

#### `runQuery(prompt, sessionId, containerInput): Promise<QueryResult>`
Execute a query with the agent. Returns:
- `newSessionId` - Updated session ID for continuity
- `lastMessageId` - ID of the last message (for resumption)
- `closedDuringQuery` - Whether the query was interrupted by close signal

#### `pushMessage(message: string): void`
Push a follow-up message to an active query (for message piping)

#### `endQuery(): void`
End the current query session

#### `supportsSessionContinuity(): boolean`
Whether the harness supports conversation continuity across queries

#### `supportsStreaming(): boolean`
Whether the harness supports streaming responses

#### `cleanup(): Promise<void>`
Clean up resources before shutdown

## Comparison: Claude Code vs Gemini vs Bob

| Feature | Claude Code | Gemini CLI | Bob |
|---------|-------------|------------|-----|
| **Session Continuity** | ✅ Built-in (SDK managed) | ✅ Custom implementation | ✅ Custom implementation |
| **Streaming** | ✅ Full streaming | ✅ Chunk-based streaming | ✅ Chunk-based streaming |
| **Tool Calling** | ✅ Rich tool ecosystem | ⚠️ Basic (needs implementation) | ⚠️ Basic (needs implementation) |
| **MCP Support** | ✅ Native | ❌ Not supported | ❌ Not supported |
| **Message Piping** | ✅ AsyncIterable pattern | ⚠️ Limited (adds to history) | ⚠️ Limited (adds to history) |
| **Bash Execution** | ✅ Sandboxed | ❌ Needs implementation | ❌ Needs implementation |
| **File Operations** | ✅ Read/Write/Edit/Glob/Grep | ❌ Needs implementation | ❌ Needs implementation |
| **Web Access** | ✅ WebSearch/WebFetch | ❌ Needs implementation | ❌ Needs implementation |
| **Agent Teams** | ✅ Subagent orchestration | ❌ Not supported | ❌ Not supported |
| **Memory System** | ✅ CLAUDE.md files | ⚠️ System prompt only | ⚠️ System prompt only |
| **Conversation Archiving** | ✅ Pre-compact hooks | ❌ Not implemented | ❌ Not implemented |
| **Session Storage** | `.claude/` directory | `.gemini-sessions/` directory | `.bob/` or `.agents/` directory |

## Adding a New Harness

To add support for a new AI provider:

1. **Create a new harness class** extending `AgentHarness`:
   ```typescript
   export class MyAIHarness extends AgentHarness {
     async initialize() { /* ... */ }
     async runQuery(prompt, sessionId, containerInput) { /* ... */ }
     // ... implement other methods
   }
   ```

2. **Add to the factory** in `index.ts`:
   ```typescript
   function createAgentHarness(containerInput, mcpServerPath) {
     const harnessType = process.env.AGENT_HARNESS_TYPE || 'claude-code';
     
     switch (harnessType.toLowerCase()) {
       case 'myai':
         return new MyAIHarness(config);
       // ... other cases
     }
   }
   ```

3. **Add dependencies** to `package.json`:
   ```json
   {
     "dependencies": {
       "my-ai-sdk": "^1.0.0"
     }
   }
   ```

4. **Update Dockerfile** if needed (install CLI tools, etc.)

## Testing

To test a harness implementation:

1. **Build the container**:
   ```bash
   cd container
   ./build.sh
   ```

2. **Set environment variables**:
   ```bash
   export AGENT_HARNESS_TYPE=gemini
   export GEMINI_API_KEY=your-key-here
   ```

3. **Run NanoClaw**:
   ```bash
   npm run dev
   ```

4. **Send a test message** via your configured channel

## Migration Notes

### From Original to Refactored

The refactored architecture is **backward compatible**. If `AGENT_HARNESS_TYPE` is not set, it defaults to `claude-code`, which preserves all original functionality.

### Session Storage

- **Claude Code**: Sessions stored in `.claude/` directory (SDK managed)
- **Gemini**: Sessions stored in `.gemini-sessions/` directory (custom JSON format)

Sessions are **not compatible** between harnesses. Switching harnesses will start fresh conversations.

## Limitations

### Gemini Harness Limitations

The current Gemini implementation is **basic** and lacks several features:

1. **No tool execution** - Bash, file operations, web access not implemented
2. **No MCP support** - Scheduler tools won't work
3. **Limited message piping** - Messages added to history, not streamed to active query
4. **No conversation archiving** - Pre-compact hooks not available
5. **Simpler memory model** - Only system prompt, no CLAUDE.md file loading

These could be implemented by:
- Adding function calling support (Gemini supports this)
- Implementing tool execution wrappers
- Creating a custom MCP bridge
- Adding file watching for CLAUDE.md updates

## Future Enhancements

Potential improvements:

1. **Tool Abstraction Layer** - Unified tool interface for all harnesses
2. **MCP Bridge** - Generic MCP-to-function-calling adapter
3. **Session Format Converter** - Migrate sessions between harnesses
4. **Harness Capabilities API** - Query what features a harness supports
5. **Fallback Chain** - Try multiple harnesses if one fails
6. **A/B Testing** - Route different groups to different harnesses

## Contributing

When contributing a new harness:

1. Implement all required methods from `AgentHarness`
2. Document limitations clearly
3. Add tests for core functionality
4. Update this README with configuration details
5. Consider tool support and MCP integration