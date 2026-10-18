// src/main.ts
/**
 * REMOWSER – Main Process & Agentic Orchestrator
 * Implements:
 *  - Electron Browser Shell with embedded Chromium Webview
 *  - Playwright controller attached via Chrome DevTools Protocol (CDP)
 *  - Autonomous Observe-Decide-Act Agent Loop
 *  - Security Boundaries & Human-in-the-Loop Interceptor
 *  - Built-in Lightweight Ad/Tracker Blocker
 *  - Local LLM (REMO) integration via Ollama/llama.cpp
 */

import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import axios from 'axios';
import type { AgentCommand, AgentStatus, TaskItem, HumanVerificationData, ChatMessage } from './types/ipc';

// ---------------------------------------------------------------------------
// Configuration & Flags
// ---------------------------------------------------------------------------
const CDP_PORT = 9222;
// Enable Chrome DevTools Protocol remote debugging port for Playwright CDP attachment
app.commandLine.appendSwitch('remote-debugging-port', `${CDP_PORT}`);
app.commandLine.appendSwitch('enable-features', 'NetworkService,NetworkServiceInProcess');

let mainWindow: BrowserWindow | null = null;
let pwBrowser: Browser | null = null;
let currentActivePage: Page | null = null;

// Task Queue Management
const taskQueue: TaskItem[] = [];
let currentRunningTaskId: string | null = null;
let resumeResolver: ((value: boolean) => void) | null = null;
let abortController: AbortController | null = null;

// LLM Configuration
const LLM_BASE_URL = 'http://localhost:11434';
let preferredModel = 'qwen2.5:7b-instruct-q4_0';

// ---------------------------------------------------------------------------
// IPC Broadcast Helpers
// ---------------------------------------------------------------------------
function broadcastStatus(message: string, state: AgentStatus['state'] = 'running', step?: number, maxSteps?: number) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent-status', { message, state, step, maxSteps });
  }
}

function broadcastTaskQueue() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task-queue-update', [...taskQueue]);
  }
}

function broadcastChat(sender: 'user' | 'remo' | 'system', text: string, actionDetails?: AgentCommand, extractedData?: { target: string; content: string }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const msg: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sender,
      text,
      timestamp: Date.now(),
      actionDetails,
      extractedData
    };
    mainWindow.webContents.send('chat-message', msg);
  }
}

function broadcastHumanVerification(data: HumanVerificationData | null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('human-verification-required', data);
  }
}

function broadcastBrowserNavigate(url: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser-navigate-event', url);
  }
}

// ---------------------------------------------------------------------------
// System Ad-Blocker (Lightweight network filter)
// ---------------------------------------------------------------------------
function setupAdBlocker() {
  try {
    const adPatterns = [
      '*://*.doubleclick.net/*',
      '*://*.googleadservices.com/*',
      '*://*.googlesyndication.com/*',
      '*://*.adnxs.com/*',
      '*://*.adservice.google.com/*',
      '*://*.scorecardresearch.com/*',
      '*://*.outbrain.com/*',
      '*://*.taboola.com/*',
      '*://*.amazon-adsystem.com/*'
    ];

    session.defaultSession.webRequest.onBeforeRequest({ urls: adPatterns }, (details, callback) => {
      callback({ cancel: true });
    });
  } catch (err) {
    console.warn('[AdBlocker] Notice:', err);
  }
}

// ---------------------------------------------------------------------------
// Playwright Autonomous Browser Controller
// ---------------------------------------------------------------------------
async function initPlaywrightAgentBrowser(): Promise<Browser> {
  broadcastStatus('Initializing autonomous browser engine...', 'running');
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('[Playwright] Autonomous background Chromium browser initialized.');
    return browser;
  } catch (err: any) {
    console.warn('[Playwright] Headless launch fallback to CDP...', err.message);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch {
      return await chromium.launch({ headless: true });
    }
  }
}

// ---------------------------------------------------------------------------
// DOM Simplification Execution
// ---------------------------------------------------------------------------
interface SimplifierResult {
  title: string;
  url: string;
  interactablesCount: number;
  security: {
    hasCaptcha: boolean;
    hasLoginForm: boolean;
    hasCheckoutForm: boolean;
    securityReason: string;
  };
  domContext: string;
}

async function extractSimplifiedDOM(page: Page): Promise<SimplifierResult> {
  const payloadPath = join(__dirname, 'agents', 'domSimplifier.js');
  let scriptContent = '';
  if (existsSync(payloadPath)) {
    scriptContent = readFileSync(payloadPath, 'utf-8');
  } else {
    const altPath = join(__dirname, '..', 'src', 'agents', 'domSimplifier.js');
    if (existsSync(altPath)) {
      scriptContent = readFileSync(altPath, 'utf-8');
    } else {
      throw new Error(`domSimplifier.js payload not found at ${payloadPath}`);
    }
  }

  const result = await page.evaluate((scriptStr: string) => {
    return eval(scriptStr);
  }, scriptContent);

  return result as SimplifierResult;
}

// ---------------------------------------------------------------------------
// REMO Local LLM Caller (Ollama / llama.cpp)
// ---------------------------------------------------------------------------
async function ensureOllamaService(): Promise<void> {
  try {
    const res = await axios.get(`${LLM_BASE_URL}/api/tags`, { timeout: 1200 });
    if (res.status === 200) {
      console.log('[REMO Engine] Local Ollama service is already running on port 11434.');
      return;
    }
  } catch {
    // Service not active, start automatically
  }

  console.log('[REMO Engine] Auto-starting local Ollama service in background...');
  broadcastStatus('🚀 Starting local AI engine (REMO)...', 'running');

  try {
    const proc = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore'
    });
    proc.unref();

    // Wait up to 12 seconds for Ollama to become ready
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await axios.get(`${LLM_BASE_URL}/api/tags`, { timeout: 1000 });
        if (res.status === 200) {
          console.log('[REMO Engine] Ollama background service is now online and ready.');
          break;
        }
      } catch {
        // Continue waiting
      }
    }
  } catch (err: any) {
    console.warn('[REMO Engine] Auto-launch of Ollama service notice:', err.message);
  }
}

async function autoDetectModel(): Promise<string> {
  try {
    const res = await axios.get(`${LLM_BASE_URL}/api/tags`, { timeout: 2500 });
    const models: Array<{ name: string }> = res.data?.models || [];
    if (models.length > 0) {
      const qwen7b = models.find(m => m.name.toLowerCase().includes('qwen') && m.name.includes('7b'));
      if (qwen7b) {
        preferredModel = qwen7b.name;
        return preferredModel;
      }
      const llama8b = models.find(m => m.name.toLowerCase().includes('llama') && m.name.includes('8b'));
      if (llama8b) {
        preferredModel = llama8b.name;
        return preferredModel;
      }
      const qwen3b = models.find(m => m.name.toLowerCase().includes('qwen') && m.name.includes('3b'));
      if (qwen3b) {
        preferredModel = qwen3b.name;
        return preferredModel;
      }
      const anyChat = models.find(m => !m.name.includes('embed'));
      if (anyChat) {
        preferredModel = anyChat.name;
        return preferredModel;
      }
      preferredModel = models[0].name;
      return preferredModel;
    }
  } catch {
    // Keep default
  }
  return preferredModel;
}

async function callRemoLLM(userGoal: string, domContext: string, stepHistory: string[]): Promise<AgentCommand> {
  const endpoint = `${LLM_BASE_URL}/v1/chat/completions`;

  const systemPrompt = `You are REMO, an expert autonomous browser agent built for REMOWSER.
Your task is to fulfill the User's Goal by interacting with the simplified web page.

CRITICAL INSTRUCTIONS:
1. Always respond in STRICT JSON format with NO markdown wrapping, matching this schema:
{
  "thought": "Brief 1-sentence reasoning for what you are doing next",
  "action": "open_tab" | "switch_tab" | "click" | "type" | "scroll" | "extract_data" | "task_complete",
  "url": "https://..." (required for open_tab),
  "id": 12 (integer REMOWSER_ID, required for click and type),
  "text": "text to type" (required for type),
  "direction": "down" | "up" (for scroll),
  "target": "description of extracted info" (for extract_data),
  "message": "Final answer or completion summary" (for task_complete)
}
2. When searching or filling inputs, identify the input element [#ID] and use {"action": "type", "id": ID, "text": "..."}.
3. After typing a query, click the submit/search button or press enter.
4. When you have found the requested answer, use {"action": "extract_data", "target": "..."} followed by {"action": "task_complete", "message": "..."}.
5. Never hallucinate IDs. Only use [#ID] numbers visible in the Interactive Elements list.`;

  const userMessage = [
    `USER GOAL: "${userGoal}"`,
    '',
    'ACTION HISTORY SO FAR:',
    stepHistory.length > 0 ? stepHistory.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(Starting fresh)',
    '',
    domContext
  ].join('\n');

  try {
    const response = await axios.post(
      endpoint,
      {
        model: preferredModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.1,
        max_tokens: 600,
        stream: false
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 45000
      }
    );

    const rawContent = response.data?.choices?.[0]?.message?.content || '';
    return parseCommandJSON(rawContent);
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error(`Could not connect to REMO LLM at ${LLM_BASE_URL}. Ensure Ollama is running ('ollama serve') and model '${preferredModel}' is loaded.`);
    }
    throw new Error(`LLM call failed: ${err.message}`);
  }
}

function parseCommandJSON(raw: string): AgentCommand {
  let cleaned = raw.trim();
  // Strip code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  // Attempt direct JSON parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // Extract first JSON object match
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // Fallback
      }
    }
  }

  // Fallback default
  return {
    action: 'task_complete',
    message: `REMO Output: ${raw.slice(0, 300)}`
  };
}

// ---------------------------------------------------------------------------
// Autonomous Observe-Decide-Act Agent Loop
// ---------------------------------------------------------------------------
async function runAgentTaskLoop(task: TaskItem) {
  const MAX_STEPS = 15;
  let step = 0;
  const history: string[] = [];

  try {
    currentRunningTaskId = task.id;
    task.status = 'in_progress';
    broadcastTaskQueue();
    broadcastStatus(`REMO started task: "${task.prompt}"`, 'running', 1, MAX_STEPS);
    broadcastChat('system', `🚀 Task initialized: "${task.prompt}"`);

    // Ensure Playwright browser is ready
    if (!pwBrowser || !pwBrowser.isConnected()) {
      pwBrowser = await initPlaywrightAgentBrowser();
    }

    let page: Page;
    let contextToClean: BrowserContext | null = null;
    try {
      const context = await pwBrowser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 REMOWSER/1.0',
        viewport: { width: 1280, height: 800 }
      });
      contextToClean = context;
      page = await context.newPage();
    } catch {
      // Fallback for CDP connections where Target.createBrowserContext is not supported
      const cdpContext = pwBrowser.contexts()[0];
      page = await cdpContext.newPage();
    }
    currentActivePage = page;

    // Check if initial prompt is a direct URL or a search query
    let initialUrl = 'https://duckduckgo.com';
    const trimmed = task.prompt.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      initialUrl = trimmed;
    } else if (trimmed.includes('.com') || trimmed.includes('.org') || trimmed.includes('.net')) {
      const match = trimmed.match(/https?:\/\/[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*/);
      if (match) {
        initialUrl = match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
      }
    }

    broadcastStatus(`Navigating to ${initialUrl}...`, 'running', 1, MAX_STEPS);
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    broadcastBrowserNavigate(initialUrl);

    while (step < MAX_STEPS) {
      step++;
      task.currentStep = `Step ${step}/${MAX_STEPS}`;
      broadcastTaskQueue();

      // Give dynamic content a moment to settle
      await page.waitForTimeout(1000);

      // 1. OBSERVE: Run DOM Simplifier
      broadcastStatus(`Reading and simplifying page structure...`, 'running', step, MAX_STEPS);
      const domResult = await extractSimplifiedDOM(page);

      // 2. SECURITY BOUNDARY & HUMAN-IN-THE-LOOP CHECK
      if (domResult.security.hasCaptcha || domResult.security.hasLoginForm || domResult.security.hasCheckoutForm) {
        const secReason = domResult.security.securityReason || 'Security verification required';
        const detectedType = domResult.security.hasCaptcha ? 'captcha' : (domResult.security.hasLoginForm ? 'login' : 'checkout');

        broadcastStatus(`⏸️ Paused: ${secReason}`, 'paused', step, MAX_STEPS);
        task.status = 'paused';
        broadcastTaskQueue();

        // Surface the URL to the main view so user can resolve it
        broadcastBrowserNavigate(page.url());

        broadcastHumanVerification({
          taskId: task.id,
          reason: secReason,
          url: page.url(),
          detectedType
        });

        broadcastChat('system', `⚠️ **Human-in-the-Loop Intercepted**: ${secReason}. The tab is surfaced in your browser view. Please complete the action and click 'Approve / Resume Agent' in the sidebar.`);

        // Wait for resume signal
        const shouldContinue = await new Promise<boolean>((resolve) => {
          resumeResolver = resolve;
        });

        broadcastHumanVerification(null);

        if (!shouldContinue) {
          throw new Error('Task was aborted by user during verification checkpoint.');
        }

        broadcastStatus('Resuming autonomous execution...', 'running', step, MAX_STEPS);
        task.status = 'in_progress';
        broadcastTaskQueue();
        await page.waitForTimeout(1500); // Wait for user changes to settle
        continue;
      }

      // 3. DECIDE: Prompt REMO Local LLM
      broadcastStatus(`REMO is thinking...`, 'running', step, MAX_STEPS);
      const command = await callRemoLLM(task.prompt, domResult.domContext, history);

      if (command.thought) {
        broadcastChat('remo', `💭 *${command.thought}*`);
      }

      // 4. ACT: Execute command via Playwright
      history.push(`${command.action} ${command.id ? `on #${command.id}` : ''} ${command.text ? `text="${command.text}"` : ''} ${command.url || ''}`);

      if (command.action === 'task_complete') {
        const finalMsg = command.message || 'Task completed successfully!';
        task.status = 'completed';
        task.result = finalMsg;
        broadcastTaskQueue();
        broadcastStatus(`✅ ${finalMsg}`, 'completed', step, MAX_STEPS);
        broadcastChat('remo', `🎉 **Task Completed**: ${finalMsg}`, command);
        break;
      }

      broadcastStatus(`Executing: ${command.action}`, 'running', step, MAX_STEPS);

      switch (command.action) {
        case 'open_tab': {
          if (command.url) {
            await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            broadcastBrowserNavigate(command.url);
            broadcastChat('remo', `🌐 Navigated to: ${command.url}`, command);
          }
          break;
        }

        case 'click': {
          if (command.id) {
            const selector = `[data-remowser-id="${command.id}"]`;
            const element = page.locator(selector).first();
            await element.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            await element.click({ timeout: 5000, force: true });
            broadcastChat('remo', `👆 Clicked element [#${command.id}]`, command);
            broadcastBrowserNavigate(page.url());
          }
          break;
        }

        case 'type': {
          if (command.id && command.text) {
            const selector = `[data-remowser-id="${command.id}"]`;
            const input = page.locator(selector).first();
            await input.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
            await input.click({ force: true }).catch(() => {});
            await input.fill(command.text, { timeout: 5000 });
            // If it's a search input, optionally press Enter
            await input.press('Enter').catch(() => {});
            broadcastChat('remo', `⌨️ Typed "${command.text}" into [#${command.id}]`, command);
            broadcastBrowserNavigate(page.url());
          }
          break;
        }

        case 'scroll': {
          const delta = command.direction === 'up' ? -600 : 600;
          await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), delta);
          broadcastChat('remo', `📜 Scrolled page ${command.direction || 'down'}`, command);
          break;
        }

        case 'extract_data': {
          const target = command.target || 'Information';
          const fullText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
          broadcastChat('remo', `📄 **Extracted Data** (${target}):\n${fullText.slice(0, 400)}...`, command, { target, content: fullText.slice(0, 600) });
          break;
        }

        case 'switch_tab': {
          // Handled if multiple pages are active
          break;
        }
      }
    }

    if (step >= MAX_STEPS && task.status !== 'completed') {
      task.status = 'completed';
      task.result = 'Reached maximum step limit.';
      broadcastStatus('Task finished (step limit reached)', 'completed');
      broadcastChat('system', 'ℹ️ Reached maximum allowed autonomous steps.');
    }

    await page.close().catch(() => {});
    if (contextToClean) {
      await contextToClean.close().catch(() => {});
    }
  } catch (err: any) {
    console.error('[Agent Task Error]', err);
    task.status = 'failed';
    task.result = err.message;
    broadcastTaskQueue();
    broadcastStatus(`Error: ${err.message}`, 'error');
    broadcastChat('system', `❌ **Task Error**: ${err.message}`);
  } finally {
    currentRunningTaskId = null;
    resumeResolver = null;
    broadcastTaskQueue();
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
function registerIPCHandlers() {
  ipcMain.handle('submit-prompt', async (_event, prompt: string) => {
    if (!prompt || !prompt.trim()) {
      return { success: false, error: 'Empty prompt provided.' };
    }

    const newTask: TaskItem = {
      id: `task_${Date.now()}`,
      prompt: prompt.trim(),
      status: 'pending',
      createdAt: Date.now()
    };

    taskQueue.push(newTask);
    broadcastTaskQueue();
    broadcastChat('user', prompt.trim());

    // Run task asynchronously
    setTimeout(() => {
      runAgentTaskLoop(newTask);
    }, 100);

    return { success: true, taskId: newTask.id };
  });

  ipcMain.handle('cancel-task', async (_event, taskId: string) => {
    const task = taskQueue.find(t => t.id === taskId);
    if (task) {
      task.status = 'failed';
      task.result = 'Cancelled by user.';
      if (resumeResolver) {
        resumeResolver(false);
      }
      broadcastTaskQueue();
      broadcastStatus('Task cancelled', 'idle');
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('resume-agent', async (_event, _taskId: string) => {
    if (resumeResolver) {
      resumeResolver(true);
      resumeResolver = null;
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('get-models', async () => {
    const detected = await autoDetectModel();
    return [detected, 'qwen2.5:7b-instruct-q4_0', 'llama3.1:8b-instruct-q4_0', 'qwen2.5:3b'];
  });
}

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  setupAdBlocker();
  registerIPCHandlers();

  // 1. Ensure local LLM server is up and running in background with zero user intervention
  await ensureOllamaService();
  await autoDetectModel();

  // 2. Resolve App Icon
  const possibleIcons = [
    join(__dirname, 'assets', 'icon.png'),
    join(__dirname, '..', 'assets', 'icon.png'),
    join(__dirname, 'renderer', 'icon.png'),
    '/home/senju/Downloads/REMoWSER browser logo.png'
  ];
  const iconPath = possibleIcons.find(p => existsSync(p));

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'REMOWSER – Local AI Browser',
    backgroundColor: '#0f1117',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // Enables embedded Chromium webview for the browser engine
    }
  });

  // Load the React frontend
  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    broadcastStatus(`⚡ REMO Online (${preferredModel})`, 'idle');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
});

app.on('window-all-closed', async () => {
  if (pwBrowser) await pwBrowser.close().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
