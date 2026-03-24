/**
 * Bob Agent Harness
 * Bob is a fork of Google Gemini with similar API
 * Uses .bob or .agents folder for session storage
 *
 * EXPERIMENTAL: This implementation uses @google/genai v1.46.0 which has
 * an unstable API. The actual API differs from the documented interface.
 * This harness is provided as a reference implementation and may require
 * updates when the @google/genai package stabilizes.
 *
 * Note: This is a basic implementation using the @google/genai SDK
 * (Bob uses the same API structure as Gemini)
 */

import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
// Note: These types may not match the actual @google/genai exports
// Using 'any' for compatibility until the package API stabilizes
type GenerativeModel = any;
type Part = any;
import {
  AgentHarness,
  AgentHarnessConfig,
  ContainerInput,
  ContainerOutput,
} from './agent-harness.js';

interface BobMessage {
  role: 'user' | 'model';
  parts: Part[];
}

interface BobSession {
  history: BobMessage[];
  lastMessageId?: string;
}

/**
 * Bob Harness
 * 
 * Bob is a Gemini fork with the same capabilities and limitations.
 * Uses .bob folder (or .agents as fallback) for session storage.
 */
export class BobHarness extends AgentHarness {
  private client: GoogleGenAI | null = null;
  private model: GenerativeModel | null = null;
  private currentSession: BobSession | null = null;
  private sessionStoragePath: string;

  constructor(config: AgentHarnessConfig) {
    super(config);
    
    // Try .bob first, fallback to .agents
    const bobPath = path.join(config.workingDirectory, '.bob');
    const agentsPath = path.join(config.workingDirectory, '.agents');
    
    // Check if .bob exists or can be created
    try {
      fs.mkdirSync(bobPath, { recursive: true });
      this.sessionStoragePath = bobPath;
    } catch {
      // Fallback to .agents
      this.sessionStoragePath = agentsPath;
    }
  }

  async initialize(): Promise<void> {
    const apiKey = this.config.environment?.BOBSHELL_API_KEY;
    if (!apiKey) {
      throw new Error('BOBSHELL_API_KEY not found in environment');
    }

    // Bob uses the same API as Gemini
    this.client = new GoogleGenAI({ apiKey });
    
    // Use Bob's model (defaults to gemini-2.0-flash-exp since Bob is a fork)
    const modelName = this.config.environment?.BOB_MODEL || 'gemini-2.0-flash-exp';
    
    // Note: API may differ from documentation
    this.model = (this.client as any).getGenerativeModel?.({
      model: modelName,
      systemInstruction: this.buildSystemPrompt(),
    });

    // Create session storage directory
    fs.mkdirSync(this.sessionStoragePath, { recursive: true });

    this.log(`Initialized Bob harness with model: ${modelName}`);
    this.log(`Session storage: ${this.sessionStoragePath}`);
  }

  getName(): string {
    return 'bob';
  }

  supportsSessionContinuity(): boolean {
    return true; // We implement our own session storage
  }

  supportsStreaming(): boolean {
    return true; // Bob supports streaming (via Gemini API)
  }

  pushMessage(message: string): void {
    // Bob doesn't support pushing messages to an active query
    // We add messages to history for the next query
    this.log('Warning: pushMessage not fully supported in Bob harness');
    
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
    this.log('Cleaned up Bob harness');
  }

  /**
   * Build system prompt with context
   */
  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // Base system prompt
    parts.push(
      'You are Bob, a helpful AI assistant running in a containerized environment.',
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
