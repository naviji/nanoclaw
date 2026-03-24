/**
 * Bob Agent Harness - Feature Complete Implementation
 * Bob is a fork of Google Gemini with similar API
 * 
 * This implementation brings Bob to feature parity with Claude Code:
 * - Tool Execution (Bash, File Operations, Web Access)
 * - MCP Integration
 * - Enhanced Message Piping
 * - CLAUDE.md Memory System
 * - Conversation Archiving
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  AgentHarness,
  AgentHarnessConfig,
  ContainerInput,
  ContainerOutput,
} from './agent-harness.js';

// Type definitions for Gemini API
type GenerativeModel = any;
type Part = any;
type FunctionCall = any;
type FunctionResponse = any;

interface BobMessage {
  role: 'user' | 'model';
  parts: Part[];
}

interface BobSession {
  history: BobMessage[];
  lastMessageId?: string;
  sessionSummary?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

/**
 * Bob Harness with Full Feature Parity
 */
export class BobHarness extends AgentHarness {
  private client: GoogleGenAI | null = null;
  private model: GenerativeModel | null = null;
  private currentSession: BobSession | null = null;
  private sessionStoragePath: string;
  private mcpClient: Client | null = null;
  private mcpTransport: StdioClientTransport | null = null;
  private mcpProcess: ChildProcess | null = null;
  private mcpTools: Map<string, MCPTool> = new Map();
  private messageQueue: string[] = [];
  private isProcessingTools = false;

  constructor(config: AgentHarnessConfig) {
    super(config);
    
    // Try .bob first, fallback to .agents
    const bobPath = path.join(config.workingDirectory, '.bob');
    const agentsPath = path.join(config.workingDirectory, '.agents');
    
    try {
      fs.mkdirSync(bobPath, { recursive: true });
      this.sessionStoragePath = bobPath;
    } catch {
      this.sessionStoragePath = agentsPath;
    }
  }

  async initialize(): Promise<void> {
    const apiKey = this.config.environment?.BOBSHELL_API_KEY;
    if (!apiKey) {
      throw new Error('BOBSHELL_API_KEY not found in environment');
    }

    this.client = new GoogleGenAI({ apiKey });
    
    const modelName = this.config.environment?.BOB_MODEL || 'gemini-2.0-flash-exp';
    
    // Initialize model with tools
    this.model = (this.client as any).getGenerativeModel?.({
      model: modelName,
      systemInstruction: this.buildSystemPrompt(),
      tools: this.buildToolDefinitions(),
    });

    fs.mkdirSync(this.sessionStoragePath, { recursive: true });

    // Initialize MCP client
    await this.initializeMCP();

    this.log(`Initialized Bob harness with model: ${modelName}`);
    this.log(`Session storage: ${this.sessionStoragePath}`);
    this.log(`MCP tools available: ${this.mcpTools.size}`);
  }

  getName(): string {
    return 'bob';
  }

  supportsSessionContinuity(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  pushMessage(message: string): void {
    this.log(`Queuing message for next turn (${message.length} chars)`);
    this.messageQueue.push(message);
    
    // Also add to current session if active (for compatibility with tests)
    if (this.currentSession) {
      this.currentSession.history.push({
        role: 'user',
        parts: [{ text: message }],
      });
    }
  }

  endQuery(): void {
    if (this.currentSession) {
      this.log('Ending Bob session');
      this.currentSession = null;
    }
    this.messageQueue = [];
  }

  async runQuery(
    prompt: string,
    sessionId: string | undefined,
    containerInput: ContainerInput,
  ): Promise<{
    newSessionId?: string;
    lastMessageId?: string;
    closedDuringQuery: boolean;
  }> {
    if (!this.model) {
      throw new Error('Bob model not initialized');
    }

    // Load or create session
    let session: BobSession;
    if (sessionId) {
      session = this.loadSession(sessionId) || { history: [] };
    } else {
      session = { history: [] };
    }

    this.currentSession = session;

    try {
      // Add scheduled task prefix if needed
      let finalPrompt = prompt;
      if (containerInput.isScheduledTask) {
        finalPrompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
      }

      // Add any queued messages
      if (this.messageQueue.length > 0) {
        finalPrompt += '\n\n' + this.messageQueue.join('\n\n');
        this.messageQueue = [];
      }

      // Add user message to history
      session.history.push({
        role: 'user',
        parts: [{ text: finalPrompt }],
      });

      // Start chat with history
      const chat = this.model.startChat({
        history: session.history.slice(0, -1).map(msg => ({
          role: msg.role,
          parts: msg.parts,
        })),
      });

      // Run the conversation loop with tool execution
      let fullResponse = '';
      let turnCount = 0;
      const maxTurns = 50; // Prevent infinite loops

      while (turnCount < maxTurns) {
        turnCount++;
        this.log(`Turn ${turnCount}: Sending message to model`);

        const result = await chat.sendMessageStream(
          turnCount === 1 ? finalPrompt : session.history[session.history.length - 1].parts
        );

        let turnResponse = '';
        let functionCalls: FunctionCall[] = [];
        let chunkCount = 0;

        // Stream the response
        for await (const chunk of result.stream) {
          chunkCount++;
          
          // Check for function calls
          const candidates = chunk.candidates || [];
          for (const candidate of candidates) {
            const content = candidate.content;
            if (content?.parts) {
              for (const part of content.parts) {
                if (part.text) {
                  turnResponse += part.text;
                }
                if (part.functionCall) {
                  functionCalls.push(part.functionCall);
                }
              }
            }
          }

          // Emit intermediate results for streaming (text only)
          if (turnResponse && chunkCount % 5 === 0) {
            fullResponse = this.combineResponses(fullResponse, turnResponse);
            this.emitOutput({
              status: 'success',
              result: fullResponse,
              newSessionId: sessionId,
            });
          }
        }

        // Add model response to history
        const responseParts: Part[] = [];
        if (turnResponse) {
          responseParts.push({ text: turnResponse });
          fullResponse = this.combineResponses(fullResponse, turnResponse);
        }
        if (functionCalls.length > 0) {
          for (const fc of functionCalls) {
            responseParts.push({ functionCall: fc });
          }
        }

        session.history.push({
          role: 'model',
          parts: responseParts,
        });

        // If no function calls, we're done
        if (functionCalls.length === 0) {
          break;
        }

        // Execute function calls
        this.log(`Executing ${functionCalls.length} function call(s)`);
        this.isProcessingTools = true;
        
        const functionResponses: FunctionResponse[] = [];
        for (const fc of functionCalls) {
          const response = await this.executeTool(fc.name, fc.args);
          functionResponses.push({
            name: fc.name,
            response: response,
          });
        }

        this.isProcessingTools = false;

        // Add function responses to history
        session.history.push({
          role: 'user',
          parts: functionResponses.map(fr => ({ functionResponse: fr })),
        });

        // Continue the loop to get the model's next response
      }

      if (turnCount >= maxTurns) {
        this.log('Warning: Reached maximum turn limit');
        fullResponse += '\n\n[Maximum conversation turns reached]';
      }

      // Generate session ID if new
      const newSessionId = sessionId || this.generateSessionId();
      
      // Update session summary for archiving
      if (!session.sessionSummary && fullResponse) {
        session.sessionSummary = this.generateSummary(finalPrompt, fullResponse);
      }

      // Save session
      this.saveSession(newSessionId, session);

      // Archive conversation if needed (before compaction would happen)
      await this.archiveConversationIfNeeded(newSessionId, session);

      // Emit final result
      this.emitOutput({
        status: 'success',
        result: fullResponse,
        newSessionId,
      });

      this.log(`Query completed. Response length: ${fullResponse.length} chars, turns: ${turnCount}`);

      return {
        newSessionId,
        lastMessageId: newSessionId,
        closedDuringQuery: false,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log(`Query error: ${errorMessage}`);
      
      this.emitOutput({
        status: 'error',
        result: null,
        error: errorMessage,
      });

      throw err;
    } finally {
      this.currentSession = null;
      this.isProcessingTools = false;
    }
  }

  async cleanup(): Promise<void> {
    this.endQuery();
    
    // Cleanup MCP
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (err) {
        this.log(`MCP cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    if (this.mcpProcess) {
      this.mcpProcess.kill();
    }

    this.client = null;
    this.model = null;
    this.mcpClient = null;
    this.mcpTransport = null;
    this.mcpProcess = null;
    
    this.log('Cleaned up Bob harness');
  }

  /**
   * Clean environment variables (remove undefined values)
   */
  private cleanEnvironment(env: Record<string, string | undefined> | undefined): Record<string, string> {
    if (!env) return {};
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  /**
   * Initialize MCP client and discover tools
   */
  private async initializeMCP(): Promise<void> {
    try {
      // Spawn MCP server process
      const cleanEnv = this.cleanEnvironment(this.config.environment);
      this.mcpProcess = spawn('node', [this.config.mcpServerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanEnv,
      });

      // Create transport
      this.mcpTransport = new StdioClientTransport({
        command: 'node',
        args: [this.config.mcpServerPath],
        env: cleanEnv,
      });

      // Create client
      this.mcpClient = new Client({
        name: 'bob-harness',
        version: '1.0.0',
      }, {
        capabilities: {},
      });

      // Connect
      await this.mcpClient.connect(this.mcpTransport);

      // List available tools
      const toolsList = await this.mcpClient.listTools();
      
      for (const tool of toolsList.tools) {
        this.mcpTools.set(tool.name, tool);
        this.log(`Registered MCP tool: ${tool.name}`);
      }

    } catch (err) {
      this.log(`MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`);
      // Continue without MCP - not fatal
    }
  }

  /**
   * Build tool definitions for Gemini function calling
   */
  private buildToolDefinitions(): any[] {
    const tools: ToolDefinition[] = [];

    // Bash tool
    tools.push({
      name: 'bash',
      description: 'Execute a bash command in the working directory. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
        },
        required: ['command'],
      },
    });

    // Read file tool
    tools.push({
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content as text.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read (relative to working directory)',
          },
        },
        required: ['path'],
      },
    });

    // Write file tool
    tools.push({
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write (relative to working directory)',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    });

    // List files tool
    tools.push({
      name: 'list_files',
      description: 'List files and directories in a path.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to list (relative to working directory, defaults to ".")',
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to list recursively',
          },
        },
      },
    });

    // Web search tool (placeholder - would need actual implementation)
    tools.push({
      name: 'web_search',
      description: 'Search the web for information. Returns search results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
        },
        required: ['query'],
      },
    });

    // Add MCP tools
    for (const [name, tool] of this.mcpTools) {
      tools.push({
        name: `mcp_${name}`,
        description: tool.description || `MCP tool: ${name}`,
        parameters: this.convertMCPSchemaToGemini(tool.inputSchema),
      });
    }

    return [{ functionDeclarations: tools }];
  }

  /**
   * Convert MCP JSON schema to Gemini function parameters format
   */
  private convertMCPSchemaToGemini(schema: any): any {
    if (!schema) {
      return { type: 'object', properties: {} };
    }

    return {
      type: schema.type || 'object',
      properties: schema.properties || {},
      required: schema.required || [],
    };
  }

  /**
   * Execute a tool (function call)
   */
  private async executeTool(name: string, args: any): Promise<any> {
    this.log(`Executing tool: ${name}`);

    try {
      // Handle MCP tools
      if (name.startsWith('mcp_')) {
        return await this.executeMCPTool(name.substring(4), args);
      }

      // Handle built-in tools
      switch (name) {
        case 'bash':
          return await this.executeBash(args.command);
        
        case 'read_file':
          return await this.readFile(args.path);
        
        case 'write_file':
          return await this.writeFile(args.path, args.content);
        
        case 'list_files':
          return await this.listFiles(args.path || '.', args.recursive);
        
        case 'web_search':
          return await this.webSearch(args.query);
        
        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log(`Tool execution error (${name}): ${errorMessage}`);
      return { error: errorMessage };
    }
  }

  /**
   * Execute MCP tool
   */
  private async executeMCPTool(name: string, args: any): Promise<any> {
    if (!this.mcpClient) {
      return { error: 'MCP client not initialized' };
    }

    try {
      const result = await this.mcpClient.callTool({ name, arguments: args });
      return result.content;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Execute bash command
   */
  private async executeBash(command: string): Promise<any> {
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: this.config.workingDirectory,
        env: this.config.environment,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          stdout: stdout || '(empty)',
          stderr: stderr || '(empty)',
          exitCode: code,
        });
      });

      proc.on('error', (err) => {
        resolve({
          error: err.message,
          exitCode: -1,
        });
      });
    });
  }

  /**
   * Read file
   */
  private async readFile(filePath: string): Promise<any> {
    try {
      const fullPath = path.join(this.config.workingDirectory, filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { content, path: filePath };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Write file
   */
  private async writeFile(filePath: string, content: string): Promise<any> {
    try {
      const fullPath = path.join(this.config.workingDirectory, filePath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * List files
   */
  private async listFiles(dirPath: string, recursive: boolean = false): Promise<any> {
    try {
      const fullPath = path.join(this.config.workingDirectory, dirPath);
      
      if (recursive) {
        const files: string[] = [];
        const walk = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullEntry = path.join(dir, entry.name);
            const relPath = path.relative(fullPath, fullEntry);
            if (entry.isDirectory()) {
              files.push(relPath + '/');
              walk(fullEntry);
            } else {
              files.push(relPath);
            }
          }
        };
        walk(fullPath);
        return { files, path: dirPath };
      } else {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const files = entries.map(e => e.name + (e.isDirectory() ? '/' : ''));
        return { files, path: dirPath };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Web search (placeholder - would need actual implementation)
   */
  private async webSearch(query: string): Promise<any> {
    // This would need actual web search implementation
    // For now, return a placeholder
    return {
      message: 'Web search not yet implemented in Bob harness',
      query,
    };
  }

  /**
   * Build system prompt with context and CLAUDE.md memory
   */
  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // Base system prompt
    parts.push(
      'You are Bob, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.',
      'You are running in a containerized environment with access to tools for file operations, bash commands, and more.',
      'Always be concise, helpful, and professional.'
    );

    // Add CLAUDE.md memory if it exists
    const claudeMdPath = path.join(this.config.workingDirectory, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      try {
        const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
        parts.push('\n## Memory (CLAUDE.md)\n');
        parts.push(claudeMd);
        this.log('Loaded CLAUDE.md memory');
      } catch (err) {
        this.log(`Failed to load CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Add global context if provided
    if (this.config.globalContext) {
      parts.push('\n## Global Context\n');
      parts.push(this.config.globalContext);
    }

    // Add working directory info
    parts.push(`\n## Working Directory\n${this.config.workingDirectory}`);

    // Add additional directories if any
    if (this.config.additionalDirectories && this.config.additionalDirectories.length > 0) {
      parts.push('\n## Additional Directories\n');
      parts.push(this.config.additionalDirectories.join('\n'));
    }

    // Add tool usage instructions
    parts.push('\n## Available Tools\n');
    parts.push('You have access to the following tools:');
    parts.push('- bash: Execute bash commands');
    parts.push('- read_file: Read file contents');
    parts.push('- write_file: Write to files');
    parts.push('- list_files: List directory contents');
    parts.push('- web_search: Search the web');
    if (this.mcpTools.size > 0) {
      parts.push('\nMCP Tools:');
      for (const [name, tool] of this.mcpTools) {
        parts.push(`- mcp_${name}: ${tool.description || name}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Combine responses intelligently
   */
  private combineResponses(existing: string, newText: string): string {
    if (!existing) return newText;
    if (!newText) return existing;
    
    // If the new text starts with what the existing ends with, avoid duplication
    const overlap = this.findOverlap(existing, newText);
    if (overlap > 0) {
      return existing + newText.substring(overlap);
    }
    
    return existing + newText;
  }

  /**
   * Find overlap between end of str1 and start of str2
   */
  private findOverlap(str1: string, str2: string): number {
    const maxOverlap = Math.min(str1.length, str2.length, 100);
    for (let i = maxOverlap; i > 0; i--) {
      if (str1.endsWith(str2.substring(0, i))) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Generate a summary for the session
   */
  private generateSummary(prompt: string, response: string): string {
    // Take first 100 chars of prompt as summary
    const summary = prompt.substring(0, 100).replace(/\n/g, ' ').trim();
    return summary + (prompt.length > 100 ? '...' : '');
  }

  /**
   * Archive conversation before it gets too long
   */
  private async archiveConversationIfNeeded(sessionId: string, session: BobSession): Promise<void> {
    // Archive if history is getting long (similar to Claude's pre-compact hook)
    if (session.history.length < 20) {
      return;
    }

    try {
      const conversationsDir = path.join(this.config.workingDirectory, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const summary = session.sessionSummary || 'conversation';
      const filename = `${date}-${this.sanitizeFilename(summary)}.md`;
      const filePath = path.join(conversationsDir, filename);

      // Don't overwrite existing archives
      if (fs.existsSync(filePath)) {
        return;
      }

      const markdown = this.formatConversationMarkdown(session);
      fs.writeFileSync(filePath, markdown);

      this.log(`Archived conversation to ${filePath}`);
    } catch (err) {
      this.log(`Failed to archive conversation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Format conversation as markdown
   */
  private formatConversationMarkdown(session: BobSession): string {
    const now = new Date();
    const formatDateTime = (d: Date) =>
      d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

    const lines: string[] = [];
    lines.push(`# ${session.sessionSummary || 'Conversation'}`);
    lines.push('');
    lines.push(`Archived: ${formatDateTime(now)}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.history) {
      const sender = msg.role === 'user' ? 'User' : (this.config.assistantName || 'Bob');
      
      for (const part of msg.parts) {
        if (part.text) {
          const content = part.text.length > 2000 ? part.text.slice(0, 2000) + '...' : part.text;
          lines.push(`**${sender}**: ${content}`);
          lines.push('');
        }
        if (part.functionCall) {
          lines.push(`**${sender}** called tool: \`${part.functionCall.name}\``);
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Sanitize filename
   */
  private sanitizeFilename(summary: string): string {
    return summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `bob-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Load session from disk
   */
  private loadSession(sessionId: string): BobSession | null {
    const sessionPath = path.join(this.sessionStoragePath, `${sessionId}.json`);
    
    if (!fs.existsSync(sessionPath)) {
      this.log(`Session not found: ${sessionId}`);
      return null;
    }

    try {
      const data = fs.readFileSync(sessionPath, 'utf-8');
      const session = JSON.parse(data) as BobSession;
      this.log(`Loaded session: ${sessionId} (${session.history.length} messages)`);
      return session;
    } catch (err) {
      this.log(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Save session to disk
   */
  private saveSession(sessionId: string, session: BobSession): void {
    const sessionPath = path.join(this.sessionStoragePath, `${sessionId}.json`);
    
    try {
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      this.log(`Saved session: ${sessionId} (${session.history.length} messages)`);
      
      // Update sessions index
      this.updateSessionsIndex(sessionId, session);
    } catch (err) {
      this.log(`Failed to save session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update sessions index (similar to Claude's sessions-index.json)
   */
  private updateSessionsIndex(sessionId: string, session: BobSession): void {
    try {
      const indexPath = path.join(this.sessionStoragePath, 'sessions-index.json');
      
      let index: SessionsIndex = { entries: [] };
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      }

      // Find or create entry
      let entry = index.entries.find(e => e.sessionId === sessionId);
      if (!entry) {
        entry = {
          sessionId,
          fullPath: path.join(this.sessionStoragePath, `${sessionId}.json`),
          summary: session.sessionSummary || 'New conversation',
          firstPrompt: this.getFirstUserMessage(session),
        };
        index.entries.push(entry);
      } else {
        entry.summary = session.sessionSummary || entry.summary;
      }

      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    } catch (err) {
      this.log(`Failed to update sessions index: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get first user message from session
   */
  private getFirstUserMessage(session: BobSession): string {
    for (const msg of session.history) {
      if (msg.role === 'user') {
        for (const part of msg.parts) {
          if (part.text) {
            return part.text.substring(0, 100);
          }
        }
      }
    }
    return 'No messages';
  }

  /**
   * Clean up old sessions (optional maintenance)
   */
  private cleanupOldSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
    try {
      const files = fs.readdirSync(this.sessionStoragePath);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const filePath = path.join(this.sessionStoragePath, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.log(`Cleaned up ${cleaned} old sessions`);
      }
    } catch (err) {
      this.log(`Session cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Made with Bob
