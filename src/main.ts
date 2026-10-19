// src/main.ts
/**
 * REMOWSER – Main Process & Agentic Orchestrator
 * High-performance, on-device autonomous AI browser controller.
 */

import { app, BrowserWindow, ipcMain, session, Menu } from 'electron';
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
const CHROME_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

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
// Anti-Bot Stealth & Ad-Blocker Configuration
// ---------------------------------------------------------------------------
function setupAntiBotAndStealth() {
  try {
    app.userAgentFallback = CHROME_USER_AGENT;

    const configureSession = (sess: Electron.Session) => {
      sess.setUserAgent(CHROME_USER_AGENT);

      // Ad Blocker: filter telemetry & advertising trackers
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
      sess.webRequest.onBeforeRequest({ urls: adPatterns }, (_details, callback) => {
        callback({ cancel: true });
      });

      // Emulate authentic Chrome Desktop headers (Prevents Bot Classification)
      sess.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        headers['User-Agent'] = CHROME_USER_AGENT;
        headers['sec-ch-ua'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Linux"';
        if (!headers['Accept-Language']) {
          headers['Accept-Language'] = 'en-US,en;q=0.9';
        }
        callback({ requestHeaders: headers });
      });
    };

    configureSession(session.defaultSession);
    configureSession(session.fromPartition('persist:remowser'));

    // Inject stealth properties into all webContents (embedded webviews and main window)
    app.on('web-contents-created', (_event, contents) => {
      contents.setUserAgent(CHROME_USER_AGENT);
      contents.on('dom-ready', () => {
        contents.executeJavaScript(`
          try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            if (!window.chrome) {
              window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
            }
          } catch (e) {}
        `).catch(() => {});
      });
    });
  } catch (err) {
    console.warn('[AntiBot/Stealth] Notice:', err);
  }
}

// ---------------------------------------------------------------------------
// Playwright Autonomous Stealth Browser Controller
// ---------------------------------------------------------------------------
async function initPlaywrightAgentBrowser(): Promise<Browser> {
  broadcastStatus('Initializing stealth browser engine...', 'running');
  try {
    const browser = await chromium.launch({
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--window-size=1440,900'
      ]
    });
    console.log('[Playwright] Stealth background Chromium browser initialized.');
    return browser;
  } catch (err: any) {
    console.warn('[Playwright] Launch fallback to CDP...', err.message);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch {
      return await chromium.launch({
        headless: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled']
      });
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
// Intent Detection & Query Planning Engine
// ---------------------------------------------------------------------------
interface ExecutionPlan {
  mode: 'chat' | 'current_page' | 'navigate_site' | 'search';
  replyText?: string;
  targetUrl?: string;
  searchKeywords?: string;
  userGoal: string;
  planReasoning: string;
}

function isConversationalOrMetaPrompt(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();

  // If the user is asking to open, show, find, or browse something, it is an ACTION, NEVER conversational!
  const actionKeywords = [
    'open', 'show', 'find', 'search', 'go to', 'repo', 'github', 'get', 'check',
    'look up', 'browse', 'read', 'summarize', 'navigate', 'visit', 'compare', 'deal', 'price',
    'reverse engineer', 'code', 'download', 'run', 'weather', 'stock'
  ];
  if (actionKeywords.some(kw => p.includes(kw))) {
    return false;
  }

  // 1. Common greetings & pleasantries
  const greetings = [
    'hi', 'hello', 'hey', 'yo', 'sup', 'who are you', 'what is remowser',
    'what can you do', 'help', 'what are your features', 'test', 'good morning',
    'good evening', 'thanks', 'thank you', 'how are you'
  ];
  if (greetings.includes(p)) return true;
  if (/^(hi|hello|hey|greetings|help|thanks)\b/i.test(p) && p.length < 20) return true;

  // 2. Feedback or inquiries about the browser/bot/agent itself
  const metaKeywords = [
    'bot', 'detect', 'detecting', 'captcha', 'hallucin', 'ui', 'theme', 'agent feature', 'bug report'
  ];
  const hitCount = metaKeywords.filter(k => p.includes(k)).length;
  if (hitCount >= 2 && !p.startsWith('http')) {
    return true;
  }

  return false;
}

async function callRemoDirectChat(prompt: string): Promise<string> {
  const endpoint = `${LLM_BASE_URL}/v1/chat/completions`;
  const systemPrompt = `You are REMO, the autonomous AI inside REMOWSER, an open-source local AI browser.
You run completely on-device using local Ollama models.
If the user is asking about the browser or reporting behavior, explain warmly and concisely that REMOWSER has been updated.
If it is a general question or greeting, answer warmly and helpfully. Keep answers concise (2-4 sentences or clean code).`;

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
        max_tokens: 300
      },
      { timeout: 15000 }
    );
    return res.data?.choices?.[0]?.message?.content || 'Hello! I am REMO, your autonomous local AI browser. How can I assist you with your browsing today?';
  } catch {
    return 'Hello! I am REMO, your autonomous local AI browser. You can ask me to research topics, inspect pages, or automate website tasks in the background!';
  }
}

async function extractSearchKeywords(prompt: string): Promise<string> {
  const cleanPrompt = prompt.trim();

  // 1. Multi-prefix heuristic cleaner
  let words = cleanPrompt;
  const prefixes = [
    /^(hey|hi|hello|please)\s+/i,
    /^(can you|could you|can u|would you)\s+/i,
    /^(i want you to|i want u to|i would like to|i want to)\s+/i,
    /^(show me|tell me|give me|find me|get me)\s+/i,
    /^(search for|search|find|look up|google|check out|browse to|open)\s+/i,
    /^(about|the)\s+/i
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (p.test(words)) {
        words = words.replace(p, '');
        changed = true;
      }
    }
  }

  words = words
    .replace(/\s+on\s+google\b/gi, '')
    .replace(/\s+on\s+the\s+web\b/gi, '')
    .replace(/\s+and\s+summarize\b.*/gi, '')
    .replace(/\s+and\s+compare\b.*/gi, '')
    .replace(/\s+(for\s+me|today|please|now)$/gi, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanPrompt.toLowerCase().includes('repo') && !words.toLowerCase().includes('github')) {
    words += ' github';
  }

  // 2. Try fast local LLM optimizer if available
  try {
    const res = await axios.post(
      `${LLM_BASE_URL}/v1/chat/completions`,
      {
        model: preferredModel,
        messages: [
          {
            role: 'system',
            content: 'You are a search query optimizer for an AI browser like Perplexity Comet. Extract 2 to 4 clean search keywords for the user request. Output ONLY the keywords on a single line. No quotes, no markdown, no explanations.\nExample: "i want u to show me reverse engineer anything" -> reverse engineer anything github\nExample: "hey can u open rea repo" -> rea repo github\nExample: "Search for RTX 4070 prices on Google and summarize the best deal" -> RTX 4070 price'
          },
          { role: 'user', content: cleanPrompt }
        ],
        temperature: 0.1,
        max_tokens: 30
      },
      { timeout: 3500 }
    );
    const raw = res.data?.choices?.[0]?.message?.content?.trim();
    if (raw) {
      const oneLine = raw.split('\n').map((s: string) => s.trim()).filter(Boolean).join(' ');
      const sanitized = oneLine.replace(/["'<>]/g, '').trim();
      if (sanitized.length > 2 && sanitized.length < 60) {
        return sanitized;
      }
    }
  } catch {
    // Fall back to cleaned words
  }

  return words || cleanPrompt.slice(0, 30);
}

async function planAgentExecution(prompt: string, currentUrl?: string): Promise<ExecutionPlan> {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  // 1. Direct Conversational / Meta Feedback Request
  if (isConversationalOrMetaPrompt(trimmed)) {
    return {
      mode: 'chat',
      userGoal: trimmed,
      replyText: await callRemoDirectChat(trimmed),
      planReasoning: 'Conversational / direct on-device response'
    };
  }

  // 2. Direct URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return {
      mode: 'navigate_site',
      targetUrl: trimmed,
      userGoal: trimmed,
      planReasoning: `Navigating directly to URL: ${trimmed}`
    };
  }

  // 3. Direct Domain Name (e.g., github.com, news.ycombinator.com)
  const domainMatch = trimmed.match(/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?$/);
  if (domainMatch) {
    return {
      mode: 'navigate_site',
      targetUrl: `https://${trimmed}`,
      userGoal: trimmed,
      planReasoning: `Navigating directly to domain: ${trimmed}`
    };
  }

  // 4. Current Page Action (if user is viewing an active website)
  const isOnActivePage = currentUrl && currentUrl !== 'remowser://home' && !currentUrl.startsWith('about:');
  const pageKeywords = ['this page', 'this site', 'this article', 'current page', 'summarize this', 'read this', 'on page', 'extract'];
  if (isOnActivePage && pageKeywords.some(kw => lower.includes(kw))) {
    return {
      mode: 'current_page',
      targetUrl: currentUrl,
      userGoal: trimmed,
      planReasoning: `Operating on currently active page: ${currentUrl}`
    };
  }

  // 5. GitHub / Repository Specific Queries
  if (lower.includes('github') || lower.includes('repo')) {
    const searchTerms = await extractSearchKeywords(trimmed);
    const finalTerms = searchTerms.toLowerCase().includes('github') ? searchTerms : `${searchTerms} github`;
    return {
      mode: 'search',
      targetUrl: `https://www.bing.com/search?q=${encodeURIComponent(finalTerms)}`,
      searchKeywords: finalTerms,
      userGoal: trimmed,
      planReasoning: `Searching GitHub repositories for: "${finalTerms}"`
    };
  }

  // 6. Direct Service Navigation
  if (lower.includes('youtube')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+youtube\s*(and search for|and search|for)?/i, '')
                     .replace(/on youtube/i, '').trim();
    return {
      mode: 'navigate_site',
      targetUrl: q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : 'https://www.youtube.com',
      userGoal: trimmed,
      planReasoning: 'Navigating to YouTube'
    };
  }

  if (lower.includes('wikipedia')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+wikipedia\s*(and search for|and search|for|about)?/i, '')
                     .replace(/on wikipedia/i, '').trim();
    return {
      mode: 'navigate_site',
      targetUrl: q ? `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` : 'https://www.wikipedia.org',
      userGoal: trimmed,
      planReasoning: 'Navigating to Wikipedia'
    };
  }

  if (lower.includes('reddit')) {
    const q = trimmed.replace(/^(go to|open|search|find)\s+reddit\s*(and search for|and search|for)?/i, '')
                     .replace(/on reddit/i, '').trim();
    return {
      mode: 'navigate_site',
      targetUrl: q ? `https://www.reddit.com/search/?q=${encodeURIComponent(q)}` : 'https://www.reddit.com',
      userGoal: trimmed,
      planReasoning: 'Navigating to Reddit'
    };
  }

  if (lower.includes('hacker news') || lower.includes('ycombinator')) {
    return {
      mode: 'navigate_site',
      targetUrl: 'https://news.ycombinator.com',
      userGoal: trimmed,
      planReasoning: 'Navigating to Hacker News'
    };
  }

  // 7. General Web Search: Uses Bing (Zero Captchas, Fast Structured Results)
  const searchKeywords = await extractSearchKeywords(trimmed);
  return {
    mode: 'search',
    targetUrl: `https://www.bing.com/search?q=${encodeURIComponent(searchKeywords)}`,
    searchKeywords,
    userGoal: trimmed,
    planReasoning: `Searching Bing with clean keywords: "${searchKeywords}"`
  };
}

// ---------------------------------------------------------------------------
// REMO Autonomous Action Predictor
// ---------------------------------------------------------------------------
async function callRemoLLM(userGoal: string, domContext: string, stepHistory: string[]): Promise<AgentCommand> {
  const endpoint = `${LLM_BASE_URL}/v1/chat/completions`;

  const systemPrompt = `You are REMO, an autonomous browser AI (like Perplexity Comet). You inspect the current web page to fulfill the user's goal.
Respond ONLY with a single JSON object. No conversational filler outside the JSON.

JSON SCHEMA:
{
  "thought": "1 sentence describing what you observe and what you are doing",
  "action": "click" | "type" | "scroll" | "open_tab" | "extract_data" | "task_complete",
  "id": 1,
  "url": "https://...",
  "text": "text to type",
  "direction": "down",
  "target": "target description",
  "message": "Final answer or summary to the user"
}

FEW-SHOT EXAMPLES:
Example 1 (User asks to open, find, or show a repository or site, and target link is in results):
{"thought": "Found the official REA repository link [#1].", "action": "task_complete", "url": "https://github.com/morluto/rea", "message": "Here is the morluto/rea repository on GitHub: https://github.com/morluto/rea (Reverse Engineer Anything)."}

Example 2 (User asks a question and answer is in search snippets or page):
{"thought": "Found the price details in the search results.", "action": "task_complete", "message": "The RTX 4070 is currently priced starting at $549 on Newegg and $599 on Best Buy."}

Example 3 (Navigating to a specific link to inspect details):
{"thought": "Clicking the top relevant repository result [#1].", "action": "click", "id": 1}

Example 4 (Typing a query into search box):
{"thought": "Typing query into [#10].", "action": "type", "id": 10, "text": "RTX 4070"}

CRITICAL RULES:
1. If the user wants to open, view, or find a repository or site (e.g. "open rea repo", "show me reverse engineer anything", "go to reddit"):
   - If the link is in the Search Results or page, return action: "task_complete" with the exact "url" and a summary in "message", OR return action: "click" on that link's [#ID]!
2. If the user asks a question and the answer is visible in the page text or search snippets:
   - IMMEDIATELY return action: "task_complete" with a detailed, well-formatted markdown answer citing the sources!
3. Only use [#ID] numbers that actually exist in the Interactive Elements list or Search Results. Never hallucinate IDs.`;

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

    const plan = await planAgentExecution(task.prompt, task.currentUrl);

    // 1. Direct Conversational / On-Device Chat Handling (No web browsing needed)
    if (plan.mode === 'chat') {
      const reply = plan.replyText || await callRemoDirectChat(task.prompt);
      task.status = 'completed';
      task.result = reply;
      broadcastTaskQueue();
      broadcastStatus('Ready', 'idle');
      broadcastChat('remo', reply);
      return;
    }

    // 2. Web Task Mode: Execute in background without hijacking user active tab
    const initialUrl = plan.targetUrl || 'https://www.bing.com';
    if (plan.mode === 'search') {
      broadcastChat('system', `🔍 Planned Search: **"${plan.searchKeywords}"**\n🎯 Goal: "${task.prompt}"`);
      broadcastStatus(`Searching for "${plan.searchKeywords}"...`, 'running', 1, MAX_STEPS);
    } else {
      broadcastChat('system', `🌐 Navigating to **${initialUrl}**\n🎯 Goal: "${task.prompt}"`);
      broadcastStatus(`Loading ${initialUrl}...`, 'running', 1, MAX_STEPS);
    }

    // Ensure Playwright browser is ready
    if (!pwBrowser || !pwBrowser.isConnected()) {
      pwBrowser = await initPlaywrightAgentBrowser();
    }

    let page: Page;
    let contextToClean: BrowserContext | null = null;
    try {
      const context = await pwBrowser.newContext({
        userAgent: CHROME_USER_AGENT,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Linux"'
        }
      });

      // Track newly opened tabs/popups automatically
      context.on('page', (newPage) => {
        page = newPage;
        currentActivePage = newPage;
      });

      // Inject full anti-bot evasion scripts
      await context.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch (e) {}

        try {
          (window as any).chrome = {
            app: {
              isInstalled: false,
              InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
              RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
            },
            runtime: {
              OnInstalledReason: { CHROME_UPDATE: 'chrome_update' },
              PlatformArch: { X86_64: 'x86-64' },
              PlatformOs: { LINUX: 'linux' }
            },
            loadTimes: () => ({}),
            csi: () => ({})
          };
        } catch (e) {}

        try {
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        } catch (e) {}

        try {
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        } catch (e) {}

        try {
          if (window.navigator.permissions?.query) {
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters: any) => (
              parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission } as any) :
                originalQuery(parameters)
            );
          }
        } catch (e) {}
      });

      contextToClean = context;
      page = await context.newPage();
    } catch {
      const cdpContext = pwBrowser.contexts()[0];
      page = await cdpContext.newPage();
    }
    currentActivePage = page;

    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

    while (step < MAX_STEPS) {
      step++;
      task.currentStep = `Step ${step}/${MAX_STEPS}`;
      broadcastTaskQueue();

      await page.waitForTimeout(1200);

      // Silent Bot-Detection Bypass / Search Engine Fallback
      if (page.url().includes('google.com/sorry') || page.url().includes('google.com/recaptcha')) {
        broadcastChat('system', '🔄 Search provider fallback: switching to Bing Search to bypass bot verification...');
        const cleanKeywords = plan.searchKeywords || await extractSearchKeywords(task.prompt);
        await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(cleanKeywords)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        continue;
      }

      // OBSERVE: Run DOM Simplifier
      broadcastStatus(`Reading page structure & data...`, 'running', step, MAX_STEPS);
      const domResult = await extractSimplifiedDOM(page);

      // SECURITY BOUNDARY & HUMAN-IN-THE-LOOP CHECK (Logins, Checkouts, Destructive actions)
      if (domResult.security.hasCaptcha || domResult.security.hasLoginForm || domResult.security.hasCheckoutForm) {
        const secReason = domResult.security.securityReason || 'Security verification required';
        const detectedType = domResult.security.hasCaptcha ? 'captcha' : (domResult.security.hasLoginForm ? 'login' : 'checkout');

        broadcastStatus(`⏸️ Paused: ${secReason}`, 'paused', step, MAX_STEPS);
        task.status = 'paused';
        broadcastTaskQueue();

        // Surface hidden tab to user ONLY when verification is required
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
        const sourceUrl = command.url || page.url();
        broadcastChat('remo', `🎉 **Result**:\n${finalMsg}\n\n📍 *Source: [${sourceUrl}](${sourceUrl})*`, command);

        // Auto-navigate user's active browser to the destination page (like Perplexity Comet)
        const userPromptLower = task.prompt.toLowerCase();
        const isOpenOrShowIntent = /^(open|show|go to|view|navigate|find)\b/i.test(userPromptLower) || 
                                   userPromptLower.includes('repo') || 
                                   userPromptLower.includes('github') ||
                                   userPromptLower.includes('website');
        
        if (command.url && (isOpenOrShowIntent || (!command.url.includes('bing.com') && !command.url.includes('google.com')))) {
          broadcastBrowserNavigate(command.url);
        } else if (page.url() && !page.url().includes('bing.com') && !page.url().includes('google.com')) {
          broadcastBrowserNavigate(page.url());
        }
        break;
      }

      broadcastStatus(`Executing: ${command.action}`, 'running', step, MAX_STEPS);

      switch (command.action) {
        case 'open_tab': {
          if (command.url) {
            await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            broadcastChat('remo', `🌐 Navigated to: ${command.url}`, command);
            const userPromptLower = task.prompt.toLowerCase();
            if (/^(open|show|go to|view|navigate)\b/i.test(userPromptLower) || userPromptLower.includes('repo')) {
              broadcastBrowserNavigate(command.url);
            }
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
            const firstLink = page.locator('h2 a, h3 a, .g a, article a, li.b_algo a').first();
            if (await firstLink.count() > 0) {
              await firstLink.click({ timeout: 4000, force: true }).catch(() => {});
              clicked = true;
              broadcastChat('remo', `👆 Clicked top result link`, command);
            }
          }
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);

          // If navigation brought us to a destination website, auto-navigate browser
          const userPromptLower = task.prompt.toLowerCase();
          const isOpenIntent = /^(open|show|go to|view|navigate)\b/i.test(userPromptLower) || userPromptLower.includes('repo');
          if (isOpenIntent && page.url() && !page.url().includes('bing.com') && !page.url().includes('google.com')) {
            broadcastBrowserNavigate(page.url());
          }
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
  ipcMain.handle('submit-prompt', async (_event, prompt: string, currentUrl?: string) => {
    if (!prompt || !prompt.trim()) {
      return { success: false, error: 'Empty prompt provided.' };
    }

    const newTask: TaskItem = {
      id: `task_${Date.now()}`,
      prompt: prompt.trim(),
      currentUrl: currentUrl || 'remowser://home',
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
  setupAntiBotAndStealth();
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

  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 720,
    title: 'REMOWSER – Local AI Browser',
    backgroundColor: '#090a0f',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
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
