/**
 * NanoClaw Agent Runner (Refactored with Dependency Injection)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AgentHarness,
  ContainerInput,
  ContainerOutput,
} from './agent-harness.js';
import { ClaudeCodeHarness } from './claude-code-harness.js';
import { GeminiCliHarness } from './gemini-cli-harness.js';
import { BobHarness } from './bob-harness.js';

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter((f) => f.endsWith('.json')).sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Create the appropriate agent harness based on environment configuration
 */
function createAgentHarness(
  containerInput: ContainerInput,
  mcpServerPath: string,
): AgentHarness {
  const harnessType = process.env.AGENT_HARNESS_TYPE || 'claude-code';
  
  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const config = {
    workingDirectory: '/workspace/group',
    mcpServerPath,
    additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
    globalContext: globalClaudeMd,
    environment: { ...process.env },
    assistantName: containerInput.assistantName,
  };

  switch (harnessType.toLowerCase()) {
    case 'bob':
      log('Creating Bob harness');
      return new BobHarness(config);
    
    case 'gemini':
    case 'gemini-cli':
      log('Creating Gemini CLI harness');
      return new GeminiCliHarness(config);
    
    case 'claude':
    case 'claude-code':
    default:
      log('Creating Claude Code harness');
      return new ClaudeCodeHarness(config);
  }
}

/**
 * Run the agent with IPC message piping support
 */
async function runAgentWithIpc(
  harness: AgentHarness,
  initialPrompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{
  newSessionId?: string;
  lastMessageId?: string;
  closedDuringQuery: boolean;
}> {
  // Set up output callback for streaming
  harness.setOutputCallback((output: ContainerOutput) => {
    writeOutput(output);
  });

  // Start IPC polling in parallel with the query
  let ipcPolling = true;
  let closedDuringQuery = false;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    
    if (shouldClose()) {
      log('Close sentinel detected during query, ending harness');
      closedDuringQuery = true;
      harness.endQuery();
      ipcPolling = false;
      return;
    }
    
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      harness.pushMessage(text);
    }
    
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };

  // Start IPC polling
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  try {
    // Run the query
    const result = await harness.runQuery(initialPrompt, sessionId, containerInput);
    
    return {
      ...result,
      closedDuringQuery,
    };
  } finally {
    ipcPolling = false;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Create the agent harness (dependency injection point)
  const harness = createAgentHarness(containerInput, mcpServerPath);
  
  try {
    await harness.initialize();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Failed to initialize harness: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `Harness initialization failed: ${errorMessage}`,
    });
    process.exit(1);
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, harness: ${harness.getName()})...`,
      );

      const queryResult = await runAgentWithIpc(
        harness,
        prompt,
        sessionId,
        containerInput,
      );

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      if (harness.supportsSessionContinuity()) {
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    await harness.cleanup();
  }
}

main();

// Made with Bob
