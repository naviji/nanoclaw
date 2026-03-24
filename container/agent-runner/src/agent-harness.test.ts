/**
 * Tests for AgentHarness base class and implementations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentHarness, ContainerInput, ContainerOutput } from './agent-harness.js';

// Mock implementation for testing abstract class
class MockAgentHarness extends AgentHarness {
  public initializeCalled = false;
  public runQueryCalled = false;
  public pushMessageCalled = false;
  public endQueryCalled = false;
  public cleanupCalled = false;
  
  public mockSessionId = 'mock-session-123';
  public mockError: Error | null = null;

  async initialize(): Promise<void> {
    this.initializeCalled = true;
    if (this.mockError) throw this.mockError;
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
    this.runQueryCalled = true;
    if (this.mockError) throw this.mockError;
    
    // Emit a test output
    this.emitOutput({
      status: 'success',
      result: `Processed: ${prompt}`,
      newSessionId: this.mockSessionId,
    });

    return {
      newSessionId: this.mockSessionId,
      lastMessageId: 'msg-123',
      closedDuringQuery: false,
    };
  }

  pushMessage(message: string): void {
    this.pushMessageCalled = true;
    this.log(`Pushed message: ${message}`);
  }

  endQuery(): void {
    this.endQueryCalled = true;
  }

  supportsSessionContinuity(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  getName(): string {
    return 'mock-harness';
  }

  async cleanup(): Promise<void> {
    this.cleanupCalled = true;
  }
}

describe('AgentHarness Base Class', () => {
  let harness: MockAgentHarness;
  let outputCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    harness = new MockAgentHarness({
      workingDirectory: '/workspace/test',
      mcpServerPath: '/app/mcp-server.js',
      environment: {},
    });
    outputCallback = vi.fn();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      await harness.initialize();
      expect(harness.initializeCalled).toBe(true);
    });

    it('should propagate initialization errors', async () => {
      harness.mockError = new Error('Init failed');
      await expect(harness.initialize()).rejects.toThrow('Init failed');
    });
  });

  describe('Output Callback', () => {
    it('should set output callback', () => {
      harness.setOutputCallback(outputCallback);
      expect(outputCallback).not.toHaveBeenCalled();
    });

    it('should emit outputs through callback', async () => {
      harness.setOutputCallback(outputCallback);
      
      const containerInput: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'test-group',
        chatJid: 'test@chat',
        isMain: false,
      };

      await harness.runQuery('Test prompt', undefined, containerInput);

      expect(outputCallback).toHaveBeenCalledWith({
        status: 'success',
        result: 'Processed: Test prompt',
        newSessionId: 'mock-session-123',
      });
    });

    it('should not throw if callback not set', async () => {
      const containerInput: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'test-group',
        chatJid: 'test@chat',
        isMain: false,
      };

      await expect(
        harness.runQuery('Test prompt', undefined, containerInput)
      ).resolves.toBeDefined();
    });
  });

  describe('Query Execution', () => {
    it('should run query successfully', async () => {
      const containerInput: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'test-group',
        chatJid: 'test@chat',
        isMain: false,
      };

      const result = await harness.runQuery('Test prompt', undefined, containerInput);

      expect(harness.runQueryCalled).toBe(true);
      expect(result.newSessionId).toBe('mock-session-123');
      expect(result.lastMessageId).toBe('msg-123');
      expect(result.closedDuringQuery).toBe(false);
    });

    it('should handle session continuity', async () => {
      const containerInput: ContainerInput = {
        prompt: 'Follow-up prompt',
        sessionId: 'existing-session',
        groupFolder: 'test-group',
        chatJid: 'test@chat',
        isMain: false,
      };

      const result = await harness.runQuery(
        'Follow-up prompt',
        'existing-session',
        containerInput
      );

      expect(result.newSessionId).toBeDefined();
    });

    it('should propagate query errors', async () => {
      harness.mockError = new Error('Query failed');
      
      const containerInput: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'test-group',
        chatJid: 'test@chat',
        isMain: false,
      };

      await expect(
        harness.runQuery('Test prompt', undefined, containerInput)
      ).rejects.toThrow('Query failed');
    });
  });

  describe('Message Piping', () => {
    it('should push messages', () => {
      harness.pushMessage('Follow-up message');
      expect(harness.pushMessageCalled).toBe(true);
    });

    it('should end query', () => {
      harness.endQuery();
      expect(harness.endQueryCalled).toBe(true);
    });
  });

  describe('Feature Detection', () => {
    it('should report session continuity support', () => {
      expect(harness.supportsSessionContinuity()).toBe(true);
    });

    it('should report streaming support', () => {
      expect(harness.supportsStreaming()).toBe(true);
    });

    it('should return harness name', () => {
      expect(harness.getName()).toBe('mock-harness');
    });
  });

  describe('Cleanup', () => {
    it('should cleanup successfully', async () => {
      await harness.cleanup();
      expect(harness.cleanupCalled).toBe(true);
    });
  });

  describe('Configuration', () => {
    it('should accept working directory', () => {
      const harness = new MockAgentHarness({
        workingDirectory: '/custom/path',
        mcpServerPath: '/app/mcp.js',
        environment: {},
      });
      expect(harness['config'].workingDirectory).toBe('/custom/path');
    });

    it('should accept additional directories', () => {
      const harness = new MockAgentHarness({
        workingDirectory: '/workspace',
        mcpServerPath: '/app/mcp.js',
        additionalDirectories: ['/extra1', '/extra2'],
        environment: {},
      });
      expect(harness['config'].additionalDirectories).toEqual(['/extra1', '/extra2']);
    });

    it('should accept global context', () => {
      const harness = new MockAgentHarness({
        workingDirectory: '/workspace',
        mcpServerPath: '/app/mcp.js',
        globalContext: 'Global memory content',
        environment: {},
      });
      expect(harness['config'].globalContext).toBe('Global memory content');
    });

    it('should accept environment variables', () => {
      const harness = new MockAgentHarness({
        workingDirectory: '/workspace',
        mcpServerPath: '/app/mcp.js',
        environment: { TEST_VAR: 'test-value' },
      });
      expect(harness['config'].environment?.TEST_VAR).toBe('test-value');
    });
  });
});

// Made with Bob
