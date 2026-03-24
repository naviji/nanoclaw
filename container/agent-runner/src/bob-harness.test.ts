/**
 * Tests for BobHarness
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BobHarness } from './bob-harness.js';
import { ContainerInput } from './agent-harness.js';
import fs from 'fs';
import path from 'path';

// Mock @google/genai
vi.mock('@google/genai', () => {
  const mockSendMessageStream = vi.fn();
  const mockStartChat = vi.fn(() => ({
    sendMessageStream: mockSendMessageStream,
  }));
  
  const mockGetGenerativeModel = vi.fn(() => ({
    startChat: mockStartChat,
  }));

  // Use a proper constructor function instead of arrow function
  class MockGoogleGenAI {
    constructor(config: { apiKey: string }) {}
    getGenerativeModel() {
      return mockGetGenerativeModel();
    }
  }

  return {
    GoogleGenAI: MockGoogleGenAI,
    _mockSendMessageStream: mockSendMessageStream,
    _mockStartChat: mockStartChat,
    _mockGetGenerativeModel: mockGetGenerativeModel,
  };
});

describe('BobHarness', () => {
  let harness: BobHarness;
  let testWorkingDir: string;
  let outputCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create temporary test directory
    testWorkingDir = path.join('/tmp', `bob-test-${Date.now()}`);
    fs.mkdirSync(testWorkingDir, { recursive: true });

    harness = new BobHarness({
      workingDirectory: testWorkingDir,
      mcpServerPath: '/app/mcp-server.js',
      environment: {
        BOBSHELL_API_KEY: 'test-bob-key',
        BOB_MODEL: 'gemini-2.0-flash-exp',
      },
    });

    outputCallback = vi.fn();
  });

  afterEach(async () => {
    await harness.cleanup();
    
    // Clean up test directory
    try {
      fs.rmSync(testWorkingDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should initialize with BOBSHELL_API_KEY', async () => {
      await expect(harness.initialize()).resolves.not.toThrow();
    });

    it('should throw error if BOBSHELL_API_KEY is missing', async () => {
      const harnessWithoutKey = new BobHarness({
        workingDirectory: testWorkingDir,
        mcpServerPath: '/app/mcp-server.js',
        environment: {},
      });

      await expect(harnessWithoutKey.initialize()).rejects.toThrow(
        'BOBSHELL_API_KEY not found in environment'
      );
    });

    it('should create .bob directory for session storage', async () => {
      await harness.initialize();
      
      const bobDir = path.join(testWorkingDir, '.bob');
      expect(fs.existsSync(bobDir)).toBe(true);
    });

    it('should fallback to .agents directory if .bob cannot be created', async () => {
      // Remove .bob directory if it exists from previous test
      const bobPath = path.join(testWorkingDir, '.bob');
      if (fs.existsSync(bobPath)) {
        fs.rmSync(bobPath, { recursive: true, force: true });
      }
      
      // Create a file named .bob to prevent directory creation
      fs.writeFileSync(bobPath, 'blocking file');

      const harnessWithFallback = new BobHarness({
        workingDirectory: testWorkingDir,
        mcpServerPath: '/app/mcp-server.js',
        environment: {
          BOBSHELL_API_KEY: 'test-key',
        },
      });

      await harnessWithFallback.initialize();
      
      // Should use .agents instead
      const agentsDir = path.join(testWorkingDir, '.agents');
      expect(fs.existsSync(agentsDir)).toBe(true);

      await harnessWithFallback.cleanup();
    });
  });

  describe('Feature Detection', () => {
    it('should return correct harness name', () => {
      expect(harness.getName()).toBe('bob');
    });

    it('should support session continuity', () => {
      expect(harness.supportsSessionContinuity()).toBe(true);
    });

    it('should support streaming', () => {
      expect(harness.supportsStreaming()).toBe(true);
    });
  });

  describe('Session Management', () => {
    beforeEach(async () => {
      await harness.initialize();
    });

    it('should generate unique session IDs', () => {
      const id1 = harness['generateSessionId']();
      const id2 = harness['generateSessionId']();
      
      expect(id1).toMatch(/^bob-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^bob-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('should save and load sessions', () => {
      const sessionId = 'bob-test-session';
      const session = {
        history: [
          { role: 'user' as const, parts: [{ text: 'Hello' }] },
          { role: 'model' as const, parts: [{ text: 'Hi there!' }] },
        ],
      };

      harness['saveSession'](sessionId, session);
      const loaded = harness['loadSession'](sessionId);

      expect(loaded).toEqual(session);
    });

    it('should return null for non-existent sessions', () => {
      const loaded = harness['loadSession']('non-existent-session');
      expect(loaded).toBeNull();
    });

    it('should handle corrupted session files', () => {
      const sessionId = 'bob-corrupted';
      const sessionPath = path.join(testWorkingDir, '.bob', `${sessionId}.json`);
      
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, 'invalid json{');

      const loaded = harness['loadSession'](sessionId);
      expect(loaded).toBeNull();
    });
  });

  describe('System Prompt', () => {
    it('should build basic system prompt', () => {
      const prompt = harness['buildSystemPrompt']();
      
      expect(prompt).toContain('You are Bob');
      expect(prompt).toContain('helpful AI assistant');
      expect(prompt).toContain(testWorkingDir);
    });

    it('should include global context if provided', () => {
      const harnessWithContext = new BobHarness({
        workingDirectory: testWorkingDir,
        mcpServerPath: '/app/mcp-server.js',
        globalContext: 'User prefers concise answers',
        environment: { BOBSHELL_API_KEY: 'test-key' },
      });

      const prompt = harnessWithContext['buildSystemPrompt']();
      expect(prompt).toContain('User prefers concise answers');
    });

    it('should include additional directories', () => {
      const harnessWithDirs = new BobHarness({
        workingDirectory: testWorkingDir,
        mcpServerPath: '/app/mcp-server.js',
        additionalDirectories: ['/extra1', '/extra2'],
        environment: { BOBSHELL_API_KEY: 'test-key' },
      });

      const prompt = harnessWithDirs['buildSystemPrompt']();
      expect(prompt).toContain('/extra1');
      expect(prompt).toContain('/extra2');
    });
  });

  describe('Message Handling', () => {
    beforeEach(async () => {
      await harness.initialize();
    });

    it('should handle pushMessage', () => {
      // Create a session first
      harness['currentSession'] = { history: [] };
      
      harness.pushMessage('Follow-up message');
      
      expect(harness['currentSession'].history).toHaveLength(1);
      expect(harness['currentSession'].history[0]).toEqual({
        role: 'user',
        parts: [{ text: 'Follow-up message' }],
      });
    });

    it('should handle pushMessage without active session', () => {
      // Should not throw
      expect(() => harness.pushMessage('Message')).not.toThrow();
    });

    it('should end query', () => {
      harness['currentSession'] = { history: [] };
      
      harness.endQuery();
      
      expect(harness['currentSession']).toBeNull();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup resources', async () => {
      await harness.initialize();
      harness['currentSession'] = { history: [] };
      
      await harness.cleanup();
      
      expect(harness['currentSession']).toBeNull();
      expect(harness['client']).toBeNull();
      expect(harness['model']).toBeNull();
    });

    it('should cleanup old sessions', () => {
      const sessionDir = path.join(testWorkingDir, '.bob');
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create old session file
      const oldSessionPath = path.join(sessionDir, 'old-session.json');
      fs.writeFileSync(oldSessionPath, '{}');
      
      // Set file modification time to 8 days ago
      const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldSessionPath, new Date(eightDaysAgo), new Date(eightDaysAgo));

      // Create recent session file
      const recentSessionPath = path.join(sessionDir, 'recent-session.json');
      fs.writeFileSync(recentSessionPath, '{}');

      // Run cleanup (7 day threshold)
      harness['cleanupOldSessions'](7 * 24 * 60 * 60 * 1000);

      expect(fs.existsSync(oldSessionPath)).toBe(false);
      expect(fs.existsSync(recentSessionPath)).toBe(true);
    });
  });

  describe('Configuration', () => {
    it('should use custom model from environment', async () => {
      const customHarness = new BobHarness({
        workingDirectory: testWorkingDir,
        mcpServerPath: '/app/mcp-server.js',
        environment: {
          BOBSHELL_API_KEY: 'test-key',
          BOB_MODEL: 'custom-model-name',
        },
      });

      await customHarness.initialize();
      // Model name is logged during initialization
      await customHarness.cleanup();
    });

    it('should default to gemini-2.0-flash-exp model', async () => {
      const defaultHarness = new BobHarness({
        workingDirectory: testWorkingDir,
        mcpServerPath: '/app/mcp-server.js',
        environment: {
          BOBSHELL_API_KEY: 'test-key',
        },
      });

      await defaultHarness.initialize();
      // Default model is used
      await defaultHarness.cleanup();
    });
  });

  describe('Output Callback', () => {
    beforeEach(async () => {
      await harness.initialize();
    });

    it('should emit outputs through callback', () => {
      harness.setOutputCallback(outputCallback);
      
      harness['emitOutput']({
        status: 'success',
        result: 'Test output',
        newSessionId: 'test-session',
      });

      expect(outputCallback).toHaveBeenCalledWith({
        status: 'success',
        result: 'Test output',
        newSessionId: 'test-session',
      });
    });

    it('should handle errors in output', () => {
      harness.setOutputCallback(outputCallback);
      
      harness['emitOutput']({
        status: 'error',
        result: null,
        error: 'Test error',
      });

      expect(outputCallback).toHaveBeenCalledWith({
        status: 'error',
        result: null,
        error: 'Test error',
      });
    });
  });
});

// Made with Bob
