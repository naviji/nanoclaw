/**
 * Abstract Agent Harness Interface
 * Defines the contract for different agent implementations (Claude Code, Gemini CLI, etc.)
 */

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AgentMessage {
  type: 'user' | 'assistant' | 'system' | 'result';
  content: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentHarnessConfig {
  workingDirectory: string;
  mcpServerPath: string;
  additionalDirectories?: string[];
  globalContext?: string;
  environment?: Record<string, string | undefined>;
  assistantName?: string;
}

/**
 * Callback for streaming agent outputs
 */
export type OutputCallback = (output: ContainerOutput) => void;

/**
 * Abstract base class for agent harnesses
 */
export abstract class AgentHarness {
  protected config: AgentHarnessConfig;
  protected outputCallback?: OutputCallback;

  constructor(config: AgentHarnessConfig) {
    this.config = config;
  }

  /**
   * Set the callback for streaming outputs
   */
  setOutputCallback(callback: OutputCallback): void {
    this.outputCallback = callback;
  }

  /**
   * Initialize the agent harness
   */
  abstract initialize(): Promise<void>;

  /**
   * Run a query with the agent
   * @param prompt - The user prompt
   * @param sessionId - Optional session ID for continuity
   * @param containerInput - Full container input context
   * @returns Query result with new session ID
   */
  abstract runQuery(
    prompt: string,
    sessionId: string | undefined,
    containerInput: ContainerInput,
  ): Promise<{
    newSessionId?: string;
    lastMessageId?: string;
    closedDuringQuery: boolean;
  }>;

  /**
   * Push a follow-up message to an active query
   * @param message - The message to push
   */
  abstract pushMessage(message: string): void;

  /**
   * End the current query session
   */
  abstract endQuery(): void;

  /**
   * Check if the harness supports session continuity
   */
  abstract supportsSessionContinuity(): boolean;

  /**
   * Check if the harness supports streaming responses
   */
  abstract supportsStreaming(): boolean;

  /**
   * Get the harness name/type
   */
  abstract getName(): string;

  /**
   * Cleanup resources
   */
  abstract cleanup(): Promise<void>;

  /**
   * Emit an output to the callback
   */
  protected emitOutput(output: ContainerOutput): void {
    if (this.outputCallback) {
      this.outputCallback(output);
    }
  }

  /**
   * Log a message (to stderr to avoid polluting stdout)
   */
  protected log(message: string): void {
    console.error(`[${this.getName()}] ${message}`);
  }
}

// Made with Bob
