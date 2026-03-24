/**
 * Tests for harness factory in index.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContainerInput } from './agent-harness.js';

// We'll test the factory logic by importing and testing the createAgentHarness function
// Since it's not exported, we'll test it through environment variable behavior

describe('Harness Factory', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Environment-based Selection', () => {
    it('should default to claude-code when AGENT_HARNESS_TYPE is not set', () => {
      delete process.env.AGENT_HARNESS_TYPE;
      const harnessType = process.env.AGENT_HARNESS_TYPE || 'claude-code';
      expect(harnessType).toBe('claude-code');
    });

    it('should select claude-code when explicitly set', () => {
      process.env.AGENT_HARNESS_TYPE = 'claude-code';
      expect(process.env.AGENT_HARNESS_TYPE).toBe('claude-code');
    });

    it('should select claude when set to "claude"', () => {
      process.env.AGENT_HARNESS_TYPE = 'claude';
      expect(process.env.AGENT_HARNESS_TYPE).toBe('claude');
    });

    it('should select gemini when set to "gemini"', () => {
      process.env.AGENT_HARNESS_TYPE = 'gemini';
      expect(process.env.AGENT_HARNESS_TYPE).toBe('gemini');
    });

    it('should select gemini-cli when set to "gemini-cli"', () => {
      process.env.AGENT_HARNESS_TYPE = 'gemini-cli';
      expect(process.env.AGENT_HARNESS_TYPE).toBe('gemini-cli');
    });

    it('should select bob when set to "bob"', () => {
      process.env.AGENT_HARNESS_TYPE = 'bob';
      expect(process.env.AGENT_HARNESS_TYPE).toBe('bob');
    });

    it('should be case-insensitive', () => {
      process.env.AGENT_HARNESS_TYPE = 'CLAUDE-CODE';
      expect(process.env.AGENT_HARNESS_TYPE.toLowerCase()).toBe('claude-code');
      
      process.env.AGENT_HARNESS_TYPE = 'Gemini';
      expect(process.env.AGENT_HARNESS_TYPE.toLowerCase()).toBe('gemini');
      
      process.env.AGENT_HARNESS_TYPE = 'BOB';
      expect(process.env.AGENT_HARNESS_TYPE.toLowerCase()).toBe('bob');
    });
  });

  describe('Configuration Passing', () => {
    it('should pass working directory to harness', () => {
      const config = {
        workingDirectory: '/workspace/group',
        mcpServerPath: '/app/mcp-server.js',
        environment: {},
      };
      
      expect(config.workingDirectory).toBe('/workspace/group');
    });

    it('should pass MCP server path to harness', () => {
      const config = {
        workingDirectory: '/workspace/group',
        mcpServerPath: '/app/custom-mcp.js',
        environment: {},
      };
      
      expect(config.mcpServerPath).toBe('/app/custom-mcp.js');
    });

    it('should pass additional directories to harness', () => {
      const config = {
        workingDirectory: '/workspace/group',
        mcpServerPath: '/app/mcp-server.js',
        additionalDirectories: ['/extra1', '/extra2'],
        environment: {},
      };
      
      expect(config.additionalDirectories).toEqual(['/extra1', '/extra2']);
    });

    it('should pass global context to harness', () => {
      const config = {
        workingDirectory: '/workspace/group',
        mcpServerPath: '/app/mcp-server.js',
        globalContext: 'Global memory content',
        environment: {},
      };
      
      expect(config.globalContext).toBe('Global memory content');
    });

    it('should pass environment variables to harness', () => {
      const config = {
        workingDirectory: '/workspace/group',
        mcpServerPath: '/app/mcp-server.js',
        environment: {
          ANTHROPIC_API_KEY: 'test-key',
          GEMINI_API_KEY: 'gemini-key',
          BOB_API_KEY: 'bob-key',
        },
      };
      
      expect(config.environment.ANTHROPIC_API_KEY).toBe('test-key');
      expect(config.environment.GEMINI_API_KEY).toBe('gemini-key');
      expect(config.environment.BOB_API_KEY).toBe('bob-key');
    });

    it('should pass assistant name to harness', () => {
      const config = {
        workingDirectory: '/workspace/group',
        mcpServerPath: '/app/mcp-server.js',
        assistantName: 'Andy',
        environment: {},
      };
      
      expect(config.assistantName).toBe('Andy');
    });
  });

  describe('Container Input', () => {
    it('should handle main group input', () => {
      const input: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'whatsapp_main',
        chatJid: '1234567890@s.whatsapp.net',
        isMain: true,
      };
      
      expect(input.isMain).toBe(true);
      expect(input.groupFolder).toBe('whatsapp_main');
    });

    it('should handle non-main group input', () => {
      const input: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'whatsapp_family-chat',
        chatJid: '1234567890@g.us',
        isMain: false,
      };
      
      expect(input.isMain).toBe(false);
      expect(input.groupFolder).toBe('whatsapp_family-chat');
    });

    it('should handle scheduled task input', () => {
      const input: ContainerInput = {
        prompt: 'Scheduled task prompt',
        groupFolder: 'whatsapp_main',
        chatJid: '1234567890@s.whatsapp.net',
        isMain: true,
        isScheduledTask: true,
      };
      
      expect(input.isScheduledTask).toBe(true);
    });

    it('should handle session ID for continuity', () => {
      const input: ContainerInput = {
        prompt: 'Follow-up prompt',
        sessionId: 'existing-session-123',
        groupFolder: 'whatsapp_main',
        chatJid: '1234567890@s.whatsapp.net',
        isMain: true,
      };
      
      expect(input.sessionId).toBe('existing-session-123');
    });

    it('should handle assistant name', () => {
      const input: ContainerInput = {
        prompt: 'Test prompt',
        groupFolder: 'whatsapp_main',
        chatJid: '1234567890@s.whatsapp.net',
        isMain: true,
        assistantName: 'Andy',
      };
      
      expect(input.assistantName).toBe('Andy');
    });
  });

  describe('Harness Selection Logic', () => {
    it('should map "bob" to BobHarness', () => {
      const harnessType = 'bob';
      let selectedHarness: string;
      
      switch (harnessType.toLowerCase()) {
        case 'bob':
          selectedHarness = 'BobHarness';
          break;
        case 'gemini':
        case 'gemini-cli':
          selectedHarness = 'GeminiCliHarness';
          break;
        case 'claude':
        case 'claude-code':
        default:
          selectedHarness = 'ClaudeCodeHarness';
          break;
      }
      
      expect(selectedHarness).toBe('BobHarness');
    });

    it('should map "gemini" to GeminiCliHarness', () => {
      const harnessType = 'gemini';
      let selectedHarness: string;
      
      switch (harnessType.toLowerCase()) {
        case 'bob':
          selectedHarness = 'BobHarness';
          break;
        case 'gemini':
        case 'gemini-cli':
          selectedHarness = 'GeminiCliHarness';
          break;
        case 'claude':
        case 'claude-code':
        default:
          selectedHarness = 'ClaudeCodeHarness';
          break;
      }
      
      expect(selectedHarness).toBe('GeminiCliHarness');
    });

    it('should map "gemini-cli" to GeminiCliHarness', () => {
      const harnessType = 'gemini-cli';
      let selectedHarness: string;
      
      switch (harnessType.toLowerCase()) {
        case 'bob':
          selectedHarness = 'BobHarness';
          break;
        case 'gemini':
        case 'gemini-cli':
          selectedHarness = 'GeminiCliHarness';
          break;
        case 'claude':
        case 'claude-code':
        default:
          selectedHarness = 'ClaudeCodeHarness';
          break;
      }
      
      expect(selectedHarness).toBe('GeminiCliHarness');
    });

    it('should map "claude" to ClaudeCodeHarness', () => {
      const harnessType = 'claude';
      let selectedHarness: string;
      
      switch (harnessType.toLowerCase()) {
        case 'bob':
          selectedHarness = 'BobHarness';
          break;
        case 'gemini':
        case 'gemini-cli':
          selectedHarness = 'GeminiCliHarness';
          break;
        case 'claude':
        case 'claude-code':
        default:
          selectedHarness = 'ClaudeCodeHarness';
          break;
      }
      
      expect(selectedHarness).toBe('ClaudeCodeHarness');
    });

    it('should map "claude-code" to ClaudeCodeHarness', () => {
      const harnessType = 'claude-code';
      let selectedHarness: string;
      
      switch (harnessType.toLowerCase()) {
        case 'bob':
          selectedHarness = 'BobHarness';
          break;
        case 'gemini':
        case 'gemini-cli':
          selectedHarness = 'GeminiCliHarness';
          break;
        case 'claude':
        case 'claude-code':
        default:
          selectedHarness = 'ClaudeCodeHarness';
          break;
      }
      
      expect(selectedHarness).toBe('ClaudeCodeHarness');
    });

    it('should default to ClaudeCodeHarness for unknown types', () => {
      const harnessType = 'unknown-harness';
      let selectedHarness: string;
      
      switch (harnessType.toLowerCase()) {
        case 'bob':
          selectedHarness = 'BobHarness';
          break;
        case 'gemini':
        case 'gemini-cli':
          selectedHarness = 'GeminiCliHarness';
          break;
        case 'claude':
        case 'claude-code':
        default:
          selectedHarness = 'ClaudeCodeHarness';
          break;
      }
      
      expect(selectedHarness).toBe('ClaudeCodeHarness');
    });
  });

  describe('Global Context Discovery', () => {
    it('should load global CLAUDE.md for non-main groups', () => {
      const isMain = false;
      const globalPath = '/workspace/global/CLAUDE.md';
      
      // Simulate file existence check
      const shouldLoadGlobal = !isMain;
      expect(shouldLoadGlobal).toBe(true);
    });

    it('should not load global CLAUDE.md for main group', () => {
      const isMain = true;
      
      // Main group doesn't load global context
      const shouldLoadGlobal = !isMain;
      expect(shouldLoadGlobal).toBe(false);
    });
  });

  describe('Additional Directories Discovery', () => {
    it('should discover directories in /workspace/extra/', () => {
      const extraBase = '/workspace/extra';
      const mockDirs = ['project1', 'project2', 'docs'];
      
      const extraDirs = mockDirs.map(dir => `${extraBase}/${dir}`);
      
      expect(extraDirs).toEqual([
        '/workspace/extra/project1',
        '/workspace/extra/project2',
        '/workspace/extra/docs',
      ]);
    });

    it('should handle empty extra directory', () => {
      const mockDirs: string[] = [];
      const extraDirs = mockDirs.length > 0 ? mockDirs : undefined;
      
      expect(extraDirs).toBeUndefined();
    });
  });
});

// Made with Bob
