/**
 * Claude Code Agent Harness
 * Wraps the @anthropic-ai/claude-agent-sdk for use in NanoClaw
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  AgentHarness,
  AgentHarnessConfig,
  ContainerInput,
  ContainerOutput,
} from './agent-harness.js';

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

export class ClaudeCodeHarness extends AgentHarness {
  private messageStream: MessageStream | null = null;
  private ipcPolling = false;

  constructor(config: AgentHarnessConfig) {
    super(config);
  }

  async initialize(): Promise<void> {
    this.log('Initialized Claude Code harness');
  }

  getName(): string {
    return 'claude-code';
  }

  supportsSessionContinuity(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  pushMessage(message: string): void {
    if (this.messageStream) {
      this.log(`Pushing message to active stream (${message.length} chars)`);
      this.messageStream.push(message);
    } else {
      this.log('Warning: pushMessage called but no active stream');
    }
  }

  endQuery(): void {
    if (this.messageStream) {
      this.log('Ending message stream');
      this.messageStream.end();
      this.messageStream = null;
    }
    this.ipcPolling = false;
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
    this.messageStream = new MessageStream();
    this.messageStream.push(prompt);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;
    let resultCount = 0;
    let closedDuringQuery = false;

    // Start IPC polling (will be managed externally in the main index.ts)
    this.ipcPolling = true;

    try {
      for await (const message of query({
        prompt: this.messageStream,
        options: {
          cwd: this.config.workingDirectory,
          additionalDirectories:
            this.config.additionalDirectories &&
            this.config.additionalDirectories.length > 0
              ? this.config.additionalDirectories
              : undefined,
          resume: sessionId,
          systemPrompt: this.config.globalContext
            ? {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: this.config.globalContext,
              }
            : undefined,
          allowedTools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'WebSearch',
            'WebFetch',
            'Task',
            'TaskOutput',
            'TaskStop',
            'TeamCreate',
            'TeamDelete',
            'SendMessage',
            'TodoWrite',
            'ToolSearch',
            'Skill',
            'NotebookEdit',
            'mcp__nanoclaw__*',
          ],
          env: this.config.environment,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'],
          mcpServers: {
            nanoclaw: {
              command: 'node',
              args: [this.config.mcpServerPath],
              env: {
                NANOCLAW_CHAT_JID: containerInput.chatJid,
                NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
                NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              },
            },
          },
          hooks: {
            PreCompact: [
              {
                hooks: [
                  this.createPreCompactHook(this.config.assistantName),
                ],
              },
            ],
          },
        },
      })) {
        messageCount++;
        const msgType =
          message.type === 'system'
            ? `system/${(message as { subtype?: string }).subtype}`
            : message.type;
        this.log(`[msg #${messageCount}] type=${msgType}`);

        if (message.type === 'assistant' && 'uuid' in message) {
          lastAssistantUuid = (message as { uuid: string }).uuid;
        }

        if (message.type === 'system' && message.subtype === 'init') {
          newSessionId = message.session_id;
          this.log(`Session initialized: ${newSessionId}`);
        }

        if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'task_notification'
        ) {
          const tn = message as {
            task_id: string;
            status: string;
            summary: string;
          };
          this.log(
            `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
          );
        }

        if (message.type === 'result') {
          resultCount++;
          const textResult =
            'result' in message
              ? (message as { result?: string }).result
              : null;
          this.log(
            `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
          );
          this.emitOutput({
            status: 'success',
            result: textResult || null,
            newSessionId,
          });
        }
      }

      this.log(
        `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}`,
      );

      return {
        newSessionId,
        lastMessageId: lastAssistantUuid,
        closedDuringQuery,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log(`Query error: ${errorMessage}`);
      this.emitOutput({
        status: 'error',
        result: null,
        newSessionId,
        error: errorMessage,
      });
      throw err;
    } finally {
      this.ipcPolling = false;
      this.messageStream = null;
    }
  }

  async cleanup(): Promise<void> {
    this.endQuery();
    this.log('Cleaned up Claude Code harness');
  }

  /**
   * Create hook for archiving conversations before compaction
   */
  private createPreCompactHook(assistantName?: string): HookCallback {
    return async (input, _toolUseId, _context) => {
      const preCompact = input as PreCompactHookInput;
      const transcriptPath = preCompact.transcript_path;
      const sessionId = preCompact.session_id;

      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        this.log('No transcript found for archiving');
        return {};
      }

      try {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const messages = this.parseTranscript(content);

        if (messages.length === 0) {
          this.log('No messages to archive');
          return {};
        }

        const summary = this.getSessionSummary(sessionId, transcriptPath);
        const name = summary
          ? this.sanitizeFilename(summary)
          : this.generateFallbackName();

        const conversationsDir = path.join(
          this.config.workingDirectory,
          'conversations',
        );
        fs.mkdirSync(conversationsDir, { recursive: true });

        const date = new Date().toISOString().split('T')[0];
        const filename = `${date}-${name}.md`;
        const filePath = path.join(conversationsDir, filename);

        const markdown = this.formatTranscriptMarkdown(
          messages,
          summary,
          assistantName,
        );
        fs.writeFileSync(filePath, markdown);

        this.log(`Archived conversation to ${filePath}`);
      } catch (err) {
        this.log(
          `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {};
    };
  }

  private getSessionSummary(
    sessionId: string,
    transcriptPath: string,
  ): string | null {
    const projectDir = path.dirname(transcriptPath);
    const indexPath = path.join(projectDir, 'sessions-index.json');

    if (!fs.existsSync(indexPath)) {
      this.log(`Sessions index not found at ${indexPath}`);
      return null;
    }

    try {
      const index: SessionsIndex = JSON.parse(
        fs.readFileSync(indexPath, 'utf-8'),
      );
      const entry = index.entries.find((e) => e.sessionId === sessionId);
      if (entry?.summary) {
        return entry.summary;
      }
    } catch (err) {
      this.log(
        `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return null;
  }

  private parseTranscript(content: string): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          const text =
            typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content
                  .map((c: { text?: string }) => c.text || '')
                  .join('');
          if (text) messages.push({ role: 'user', content: text });
        } else if (entry.type === 'assistant' && entry.message?.content) {
          const textParts = entry.message.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text);
          const text = textParts.join('');
          if (text) messages.push({ role: 'assistant', content: text });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }

  private formatTranscriptMarkdown(
    messages: ParsedMessage[],
    title?: string | null,
    assistantName?: string,
  ): string {
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
    lines.push(`# ${title || 'Conversation'}`);
    lines.push('');
    lines.push(`Archived: ${formatDateTime(now)}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
      const sender =
        msg.role === 'user' ? 'User' : assistantName || 'Assistant';
      const content =
        msg.content.length > 2000
          ? msg.content.slice(0, 2000) + '...'
          : msg.content;
      lines.push(`**${sender}**: ${content}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private sanitizeFilename(summary: string): string {
    return summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  private generateFallbackName(): string {
    const time = new Date();
    return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
  }
}

// Made with Bob
