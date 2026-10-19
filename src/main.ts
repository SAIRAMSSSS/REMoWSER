// src/main.ts
/**
 * REMOWSER – Main Process & Agentic Orchestrator
 * High-performance, on-device autonomous AI browser controller.
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
app.commandLine.appendSwitch('remote-debugging-port', `${CDP_PORT}`);
app.commandLine.appendSwitch('enable-features', 'NetworkService,NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');

let mainWindow: BrowserWindow | null = null;
let pwBrowser: Browser | null = null;
let currentActivePage: Page | null = null;

// Task Queue Management
const taskQueue: TaskItem[] = [];
let currentRunningTaskId: string | null = null;
let resumeResolver: ((value: boolean) => void) | null = null;

// LLM Configuration
const LLM_BASE_URL = 'http://localhost:11434';
let preferredModel = 'qwen2.5:3b';

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
  broadcastStatus('Initializing browser engine...', 'running');
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('[Playwright] Autonomous background Chromium browser initialized.');
    return browser;
  } catch (err: any) {
    console.warn('[Playwright] Launch fallback to CDP...', err.message);
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
// REMO Local LLM (Ollama / llama.cpp)
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
  broadcastStatus('Starting local AI engine (REMO)...', 'running');

  try {
    const proc = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore'
    });
    proc.unref();

    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await axios.get(`${LLM_BASE_URL}/api/tags`, { timeout: 1000 });
        if (res.status === 200) {
          console.log('[REMO Engine] Ollama background service is now online and ready.');
          break;
        }
      } catch {
        // waiting
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

// ---------------------------------------------------------------------------
// Intent Detection & Direct Conversational Chat
// ---------------------------------------------------------------------------
function isConversationalPrompt(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  const greetings = [
    'hi', 'hello', 'hey', 'yo', 'sup', 'who are you', 'what is remowser',
    'what can you do', 'help', 'what are your features', 'test', 'good morning', 'good evening'
  ];
  if (greetings.includes(p)) return true;
  if (/^(hi|hello|hey|greetings|help)\b/i.test(p) && p.length < 25) return true;
  return false;
}

async function callRemoDirectChat(prompt: string): Promise<string> {
  const endpoint = `${LLM_BASE_URL}/v1/chat/completions`;
  const systemPrompt = `You are REMO, the autonomous AI inside REMOWSER, an open-source local AI browser.
You run completely on-device using local Ollama models.
Introduce yourself warmly and concisely in 2-3 sentences.
State that you can:
1. Autonomously browse the web, search Google, and compare prices
2. Open websites, click buttons, fill search inputs, and extract data
Give 2 quick examples the user can try right now (e.g. "Search for RTX 4070 prices on Google", "Find top tech stories on Hacker News").`;

  try {
    const res = await axios.post(
      endpoint,
      {
        model: preferredModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 280
      },
      { timeout: 15000 }
    );
    return res.data?.choices?.[0]?.message?.content || 'Hello! I am REMO, your autonomous local AI browser. Ask me to search Google, compare prices, or automate any website task!';
  } catch {
    return 'Hello! I am REMO, your autonomous local AI browser. Enter any task (e.g. "Search for iPhone 16 reviews on Google" or "Open wikipedia and search Linux") and I will browse and extract the answer for you!';
  }
}

function resolveTargetNavigation(prompt: string): string {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  // 1. Direct URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  // 2. Direct domain
  const domainMatch = trimmed.match(/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?$/);
  if (domainMatch) {
    return `https://${trimmed}`;
  }

  // 3. Known services
  if (lower.includes('youtube')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+youtube\s*(and search for|and search|for)?/i, '')
                     .replace(/on youtube/i, '')
                     .trim();
    if (q) return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    return 'https://www.youtube.com';
  }

  if (lower.includes('wikipedia')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+wikipedia\s*(and search for|and search|for|about)?/i, '')
                     .replace(/on wikipedia/i, '')
                     .trim();
    if (q) return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`;
    return 'https://www.wikipedia.org';
  }

  if (lower.includes('github')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+github\s*(and search for|and search|for)?/i, '')
                     .replace(/on github/i, '')
                     .trim();
    if (q) return `https://github.com/search?q=${encodeURIComponent(q)}`;
    return 'https://github.com';
  }

  if (lower.includes('reddit')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+reddit\s*(and search for|and search|for)?/i, '')
                     .replace(/on reddit/i, '')
                     .trim();
    if (q) return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`;
    return 'https://www.reddit.com';
  }

  // 4. Default to Google Search (NOT DuckDuckGo)
  let cleanQuery = trimmed
    .replace(/^(search for|search|find|look up|browse to|google|get me)\s+/i, '')
    .trim();

  if (!cleanQuery) cleanQuery = trimmed;
  return `https://www.google.com/search?q=${encodeURIComponent(cleanQuery)}`;
}

// ---------------------------------------------------------------------------
// REMO Autonomous Action Predictor
// ---------------------------------------------------------------------------
async function callRemoLLM(userGoal: string, domContext: string, stepHistory: string[]): Promise<AgentCommand> {
  const endpoint = `${LLM_BASE_URL}/v1/chat/completions`;

  const systemPrompt = `You are REMO, an autonomous browser AI. You inspect the current web page to fulfill the user's goal.
Respond ONLY with a single JSON object. No conversational filler outside the JSON.

JSON SCHEMA:
{
  "thought": "1 sentence describing what you observe and what you are doing",
  "action": "click" | "type" | "scroll" | "open_tab" | "extract_data" | "task_complete",
  "id": 1,
  "text": "text to type",
  "direction": "down",
  "target": "target description",
  "message": "Final answer or summary to the user"
}

FEW-SHOT EXAMPLES:
Example 1 (Found the answer in page/search results):
{"thought": "I found the requested price in the search results.", "action": "task_complete", "message": "The RTX 4070 is priced starting at $549 on Newegg and $599 on Best Buy."}

Example 2 (Clicking the top relevant result link):
{"thought": "Clicking the first search result article [#3].", "action": "click", "id": 3}

Example 3 (Typing query into input):
{"thought": "Typing the search query into [#1].", "action": "type", "id": 1, "text": "RTX 4070 price"}

CRITICAL RULES:
1. If the information to answer the user is ALREADY visible in the page text or search snippets, IMMEDIATELY return action: "task_complete" with the complete message!
2. Only use [#ID] numbers that actually exist in the Interactive Elements list. Never hallucinate IDs.`;

  const userMessage = [
    `USER GOAL: "${userGoal}"`,
    '',
    'ACTIONS TAKEN SO FAR:',
    stepHistory.length > 0 ? stepHistory.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(Starting fresh on page)',
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
        max_tokens: 500,
        stream: false
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 40000
      }
    );

    const rawContent = response.data?.choices?.[0]?.message?.content || '';
    return parseCommandJSON(rawContent);
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error(`Could not connect to REMO LLM at ${LLM_BASE_URL}. Ensure Ollama is running ('ollama serve') with '${preferredModel}'.`);
    }
    throw new Error(`LLM call failed: ${err.message}`);
  }
}

function parseCommandJSON(raw: string): AgentCommand {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // Fallback
      }
    }
  }

  return {
    action: 'task_complete',
    message: raw.replace(/[{}]/g, '').slice(0, 300)
  };
}

// ---------------------------------------------------------------------------
// Autonomous Observe-Decide-Act Agent Loop
// ---------------------------------------------------------------------------
async function runAgentTaskLoop(task: TaskItem) {
  const MAX_STEPS = 10;
  let step = 0;
  const history: string[] = [];

  try {
    currentRunningTaskId = task.id;
    task.status = 'in_progress';
    broadcastTaskQueue();

    const trimmedPrompt = task.prompt.trim();

    // 1. Direct Conversational Handling
    if (isConversationalPrompt(trimmedPrompt)) {
      broadcastStatus('REMO is thinking...', 'running');
      broadcastChat('system', `💬 Conversational query: "${trimmedPrompt}"`);
      const chatReply = await callRemoDirectChat(trimmedPrompt);
      task.status = 'completed';
      task.result = chatReply;
      broadcastTaskQueue();
      broadcastStatus('Ready', 'idle');
      broadcastChat('remo', chatReply);
      return;
    }

    // 2. Resolve Target Navigation
    const initialUrl = resolveTargetNavigation(trimmedPrompt);
    broadcastStatus(`Navigating to ${initialUrl}...`, 'running', 1, MAX_STEPS);
    broadcastChat('system', `🚀 Task initialized: "${trimmedPrompt}"\n🌐 Opening: ${initialUrl}`);

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
      const cdpContext = pwBrowser.contexts()[0];
      page = await cdpContext.newPage();
    }
    currentActivePage = page;

    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    broadcastBrowserNavigate(initialUrl);

    while (step < MAX_STEPS) {
      step++;
      task.currentStep = `Step ${step}/${MAX_STEPS}`;
      broadcastTaskQueue();

      await page.waitForTimeout(1200);

      // OBSERVE: Run DOM Simplifier
      broadcastStatus(`Reading page structure & data...`, 'running', step, MAX_STEPS);
      const domResult = await extractSimplifiedDOM(page);

      // SECURITY BOUNDARY & HUMAN-IN-THE-LOOP CHECK
      if (domResult.security.hasCaptcha || domResult.security.hasLoginForm || domResult.security.hasCheckoutForm) {
        const secReason = domResult.security.securityReason || 'Security verification required';
        const detectedType = domResult.security.hasCaptcha ? 'captcha' : (domResult.security.hasLoginForm ? 'login' : 'checkout');

        broadcastStatus(`⏸️ Paused: ${secReason}`, 'paused', step, MAX_STEPS);
        task.status = 'paused';
        broadcastTaskQueue();

        broadcastBrowserNavigate(page.url());
        broadcastHumanVerification({
          taskId: task.id,
          reason: secReason,
          url: page.url(),
          detectedType
        });

        broadcastChat('system', `⚠️ **Human Action Required**: ${secReason}. The tab is surfaced in your browser. Please solve it and click 'Approve / Resume Agent' in the sidebar.`);

        const shouldContinue = await new Promise<boolean>((resolve) => {
          resumeResolver = resolve;
        });

        broadcastHumanVerification(null);
        if (!shouldContinue) {
          throw new Error('Task was cancelled by user during verification.');
        }

        broadcastStatus('Resuming autonomous execution...', 'running', step, MAX_STEPS);
        task.status = 'in_progress';
        broadcastTaskQueue();
        await page.waitForTimeout(1500);
        continue;
      }

      // DECIDE: Prompt REMO Local LLM
      broadcastStatus(`REMO is reasoning...`, 'running', step, MAX_STEPS);
      const command = await callRemoLLM(task.prompt, domResult.domContext, history);

      if (command.thought) {
        broadcastChat('remo', `💭 *${command.thought}*`);
      }

      history.push(`${command.action} ${command.id ? `on #${command.id}` : ''} ${command.text ? `text="${command.text}"` : ''} ${command.url || ''}`);

      // ACT: Check for Task Completion
      if (command.action === 'task_complete') {
        const finalMsg = command.message || 'Task completed successfully!';
        task.status = 'completed';
        task.result = finalMsg;
        broadcastTaskQueue();
        broadcastStatus(`✅ Done`, 'completed', step, MAX_STEPS);
        broadcastChat('remo', `🎉 **Result**:\n${finalMsg}`, command);
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
          const targetId = command.id;
          let clicked = false;
          if (targetId) {
            const loc = page.locator(`[data-remowser-id="${targetId}"]`).first();
            if (await loc.count() > 0) {
              await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await loc.click({ timeout: 4000, force: true }).catch(() => {});
              clicked = true;
              broadcastChat('remo', `👆 Clicked [#${targetId}]`, command);
            }
          }
          if (!clicked) {
            // Smart fallback: click first result link
            const firstLink = page.locator('h3 a, .g a, article a').first();
            if (await firstLink.count() > 0) {
              await firstLink.click({ timeout: 4000, force: true }).catch(() => {});
              broadcastChat('remo', `👆 Clicked top result link`, command);
            }
          }
          await page.waitForTimeout(1000);
          broadcastBrowserNavigate(page.url());
          break;
        }

        case 'type': {
          if (command.text) {
            let typed = false;
            if (command.id) {
              const input = page.locator(`[data-remowser-id="${command.id}"]`).first();
              if (await input.count() > 0) {
                await input.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await input.click({ force: true }).catch(() => {});
                await input.fill(command.text, { timeout: 4000 });
                await input.press('Enter').catch(() => {});
                typed = true;
                broadcastChat('remo', `⌨️ Typed "${command.text}" into [#${command.id}]`, command);
              }
            }
            if (!typed) {
              const anyInput = page.locator('input[type="text"], input[type="search"], textarea').first();
              if (await anyInput.count() > 0) {
                await anyInput.fill(command.text, { timeout: 4000 });
                await anyInput.press('Enter').catch(() => {});
                broadcastChat('remo', `⌨️ Typed "${command.text}" into search field`, command);
              }
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
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
          const fullText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : '');
          broadcastChat('remo', `📄 **Extracted Data** (${target}):\n${fullText.slice(0, 400)}...`, command, { target, content: fullText.slice(0, 600) });
          break;
        }

        case 'switch_tab': {
          break;
        }
      }
    }

    if (step >= MAX_STEPS && task.status !== 'completed') {
      task.status = 'completed';
      task.result = 'Reached maximum step limit.';
      broadcastStatus('Task finished', 'completed');
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
    return [detected, 'qwen2.5:3b', 'qwen2.5:7b-instruct-q4_0', 'llama3.1:8b-instruct-q4_0'];
  });
}

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  setupAdBlocker();
  registerIPCHandlers();

  await ensureOllamaService();
  await autoDetectModel();

  const possibleIcons = [
    join(__dirname, 'assets', 'icon.png'),
    join(__dirname, '..', 'assets', 'icon.png'),
    join(__dirname, 'renderer', 'icon.png'),
    '/home/senju/Downloads/REMoWSER browser logo.png'
  ];
  const iconPath = possibleIcons.find(p => existsSync(p));

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 720,
    title: 'REMOWSER – Local AI Browser',
    backgroundColor: '#090a0f',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

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
