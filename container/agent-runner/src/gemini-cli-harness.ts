/**
 * Gemini CLI Agent Harness
 * Wraps Google's Gemini API for use in NanoClaw
 *
 * EXPERIMENTAL: This implementation uses @google/genai v1.46.0 which has
 * an unstable API. The actual API differs from the documented interface.
 * This harness is provided as a reference implementation and may require
 * updates when the @google/genai package stabilizes.
 *
 * Note: Gemini doesn't have a direct equivalent to Claude Code's agent SDK,
 * so we implement a simpler query/response pattern with tool calling.
 */

import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
// Note: These types may not match the actual @google/genai exports
// Using 'any' for compatibility until the package API stabilizes
type GenerativeModel = any;
type Content = any;
type Part = any;
import {
  AgentHarness,
  AgentHarnessConfig,
  ContainerInput,
  ContainerOutput,
} from './agent-harness.js';

interface GeminiMessage {
  role: 'user' | 'model';
  parts: Part[];
}

interface GeminiSession {
  history: GeminiMessage[];
  lastMessageId?: string;
}

/**
 * Gemini CLI Harness
 * 
 * Limitations compared to Claude Code:
 * - No built-in session persistence (we implement our own)
 * - No built-in tool execution (we'd need to implement tool calling)
 * - No MCP server support (would need custom implementation)
 * - Simpler streaming model
 */
export class GeminiCliHarness extends AgentHarness {
  private client: GoogleGenAI | null = null;
  private model: GenerativeModel | null = null;
  private currentSession: GeminiSession | null = null;
  private sessionStoragePath: string;

  constructor(config: AgentHarnessConfig) {
    super(config);
    this.sessionStoragePath = path.join(
      config.workingDirectory,
      '.gemini-sessions'
    );
  }

  async initialize(): Promise<void> {
    const apiKey = this.config.environment?.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not found in environment');
    }

    this.client = new GoogleGenAI({ apiKey });
    
    // Use Gemini 2.0 Flash for fast responses
    // Could be configurable: gemini-2.0-flash-exp, gemini-1.5-pro, etc.
    const modelName = this.config.environment?.GEMINI_MODEL || 'gemini-2.0-flash-exp';
    
    // Note: API may differ from documentation
    this.model = (this.client as any).getGenerativeModel?.({
      model: modelName,
      systemInstruction: this.buildSystemPrompt(),
    });

    // Create session storage directory
    fs.mkdirSync(this.sessionStoragePath, { recursive: true });

    this.log(`Initialized Gemini harness with model: ${modelName}`);
  }

  getName(): string {
    return 'gemini-cli';
  }

  supportsSessionContinuity(): boolean {
    return true; // We implement our own session storage
  }

  supportsStreaming(): boolean {
    return true; // Gemini supports streaming
  }

  pushMessage(message: string): void {
    // Gemini doesn't support pushing messages to an active query
    // We'd need to end the current query and start a new one
    this.log('Warning: pushMessage not fully supported in Gemini harness');
    
    if (this.currentSession) {
      this.currentSession.history.push({
        role: 'user',
        parts: [{ text: message }],
      });
    }
  }

  endQuery(): void {
    if (this.currentSession) {
      this.log('Ending Gemini session');
      this.currentSession = null;
    }
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
      throw new Error('Gemini model not initialized');
    }

    // Load or create session
    let session: GeminiSession;
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

      // Stream the response
      const result = await chat.sendMessageStream(finalPrompt);
      let fullResponse = '';
      let chunkCount = 0;

      for await (const chunk of result.stream) {
        chunkCount++;
        const chunkText = chunk.text();
        fullResponse += chunkText;
        
        // Emit intermediate results for streaming
        if (chunkCount % 5 === 0) { // Emit every 5 chunks to reduce overhead
          this.emitOutput({
            status: 'success',
            result: fullResponse,
            newSessionId: sessionId,
          });
        }
      }

      // Add assistant response to history
      session.history.push({
        role: 'model',
        parts: [{ text: fullResponse }],
      });

      // Generate session ID if new
      const newSessionId = sessionId || this.generateSessionId();
      
      // Save session
      this.saveSession(newSessionId, session);

      // Emit final result
      this.emitOutput({
        status: 'success',
        result: fullResponse,
        newSessionId,
      });

      this.log(`Query completed. Response length: ${fullResponse.length} chars`);

      return {
        newSessionId,
        lastMessageId: newSessionId, // Use session ID as message ID
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
    }
  }

  async cleanup(): Promise<void> {
    this.endQuery();
    this.client = null;
    this.model = null;
    this.log('Cleaned up Gemini harness');
  }

  /**
   * Build system prompt with context
   */
  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // Base system prompt
    parts.push(
      'You are a helpful AI assistant running in a containerized environment.',
      'You have access to the filesystem and can execute commands.',
      'Always be concise and helpful.'
    );

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

    return parts.join('\n');
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Load session from disk
   */
  private loadSession(sessionId: string): GeminiSession | null {
    const sessionPath = path.join(this.sessionStoragePath, `${sessionId}.json`);
    
    if (!fs.existsSync(sessionPath)) {
      this.log(`Session not found: ${sessionId}`);
      return null;
    }

    try {
      const data = fs.readFileSync(sessionPath, 'utf-8');
      const session = JSON.parse(data) as GeminiSession;
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
  private saveSession(sessionId: string, session: GeminiSession): void {
    const sessionPath = path.join(this.sessionStoragePath, `${sessionId}.json`);
    
    try {
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      this.log(`Saved session: ${sessionId} (${session.history.length} messages)`);
    } catch (err) {
      this.log(`Failed to save session: ${err instanceof Error ? err.message : String(err)}`);
    }
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
