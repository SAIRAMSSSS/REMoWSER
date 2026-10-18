// src/renderer/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import type { AgentStatus, TaskItem, ChatMessage, HumanVerificationData } from '../types/ipc';
import {
  Search,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Plus,
  X,
  ShieldCheck,
  Sparkles,
  Bot,
  User,
  ListTodo,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Play,
  Square,
  Globe
} from 'lucide-react';
import './App.css';

interface Tab {
  id: string;
  title: string;
  url: string;
}

export const App: React.FC = () => {
  // Tabs & Navigation State
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 'tab_1', title: 'DuckDuckGo', url: 'https://duckduckgo.com' }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab_1');
  const [urlInput, setUrlInput] = useState<string>('https://duckduckgo.com');
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [activeSidebarTab, setActiveSidebarTab] = useState<'chat' | 'queue'>('chat');

  // Agent & Task State
  const [prompt, setPrompt] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'remo',
      text: '👋 Hi! I am REMO, your local autonomous browser agent. Enter any task or URL below—I can autonomously click, search, extract data, and fill forms in the background.',
      timestamp: Date.now()
    }
  ]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({
    message: 'Ready',
    state: 'idle'
  });
  const [taskQueue, setTaskQueue] = useState<TaskItem[]>([]);
  const [verificationData, setVerificationData] = useState<HumanVerificationData | null>(null);
  const [activeModel, setActiveModel] = useState<string>('Qwen2.5 Local');

  const webviewRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Active Tab Helper
  const currentTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  useEffect(() => {
    if (window.remowser?.getAvailableModels) {
      window.remowser.getAvailableModels().then(models => {
        if (models && models.length > 0) {
          setActiveModel(models[0]);
        }
      }).catch(() => {});
    }
  }, []);

  // IPC Event Listeners
  useEffect(() => {
    if (!window.remowser) return;

    const unsubStatus = window.remowser.onAgentStatus((status) => {
      setAgentStatus(status);
    });

    const unsubQueue = window.remowser.onTaskQueueUpdate((tasks) => {
      setTaskQueue(tasks);
    });

    const unsubChat = window.remowser.onChatMessage((msg) => {
      setMessages(prev => [...prev, msg]);
    });

    const unsubVerification = window.remowser.onHumanVerification((data) => {
      setVerificationData(data);
      if (data && data.url) {
        // Surface the URL to the active webview
        navigateWebview(data.url);
      }
    });

    const unsubNav = window.remowser.onBrowserNavigate((url) => {
      setUrlInput(url);
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url } : t));
    });

    return () => {
      unsubStatus();
      unsubQueue();
      unsubChat();
      unsubVerification();
      unsubNav();
    };
  }, [activeTabId]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, verificationData]);

  // Webview lifecycle events
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleTitleUpdate = (e: any) => {
      if (e.title) {
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, title: e.title } : t));
      }
    };

    const handleDidNavigate = (e: any) => {
      if (e.url) {
        setUrlInput(e.url);
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: e.url } : t));
      }
    };

    webview.addEventListener('page-title-updated', handleTitleUpdate);
    webview.addEventListener('did-navigate', handleDidNavigate);
    webview.addEventListener('did-navigate-in-page', handleDidNavigate);

    return () => {
      webview.removeEventListener('page-title-updated', handleTitleUpdate);
      webview.removeEventListener('did-navigate', handleDidNavigate);
      webview.removeEventListener('did-navigate-in-page', handleDidNavigate);
    };
  }, [activeTabId]);

  // Browser Navigation Actions
  const navigateWebview = (targetUrl: string) => {
    let finalUrl = targetUrl.trim();
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = `https://${finalUrl}`;
      } else {
        finalUrl = `https://duckduckgo.com/?q=${encodeURIComponent(finalUrl)}`;
      }
    }
    setUrlInput(finalUrl);
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: finalUrl } : t));
    if (webviewRef.current) {
      webviewRef.current.loadURL(finalUrl);
    }
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateWebview(urlInput);
  };

  const handleGoBack = () => {
    if (webviewRef.current?.canGoBack()) webviewRef.current.goBack();
  };

  const handleGoForward = () => {
    if (webviewRef.current?.canGoForward()) webviewRef.current.goForward();
  };

  const handleReload = () => {
    if (webviewRef.current) webviewRef.current.reload();
  };

  // Tab Management
  const handleNewTab = () => {
    const newId = `tab_${Date.now()}`;
    const newTab: Tab = {
      id: newId,
      title: 'New Tab',
      url: 'https://duckduckgo.com'
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
    setUrlInput(newTab.url);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining[0].id);
      setUrlInput(remaining[0].url);
    }
  };

  // Agent Task Submission
  const handleSubmitTask = async () => {
    if (!prompt.trim() || !window.remowser) return;
    const taskPrompt = prompt.trim();
    setPrompt('');
    setActiveSidebarTab('chat');
    await window.remowser.submitPrompt(taskPrompt);
  };

  // Human in the loop Actions
  const handleApproveResume = async () => {
    if (!verificationData || !window.remowser) return;
    await window.remowser.resumeAgent(verificationData.taskId);
    setVerificationData(null);
  };

  const handleCancelTask = async () => {
    if (!verificationData || !window.remowser) return;
    await window.remowser.cancelTask(verificationData.taskId);
    setVerificationData(null);
  };

  return (
    <div className="remowser-root">
      {/* ============================================================== */}
      {/* 1. TOP CHROME: TABS & CONTROLS                                 */}
      {/* ============================================================== */}
      <header className="browser-chrome">
        <div className="tabs-container">
          <div className="browser-brand-chip">
            <img src="./icon.png" className="app-header-logo" alt="REMOWSER" onError={(e: any) => { e.currentTarget.src = '../assets/icon.png'; }} />
            <span className="browser-brand-text">REMOWSER</span>
          </div>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => {
                setActiveTabId(tab.id);
                setUrlInput(tab.url);
              }}
            >
              <Globe size={14} className="tab-icon" />
              <span className="tab-title">{tab.title || 'Loading...'}</span>
              {tabs.length > 1 && (
                <button
                  className="tab-close"
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  title="Close Tab"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          <button className="new-tab-btn" onClick={handleNewTab} title="New Tab">
            <Plus size={15} />
          </button>
        </div>

        {/* Omnibox & Navigation Bar */}
        <div className="nav-toolbar">
          <div className="nav-buttons">
            <button onClick={handleGoBack} title="Back">
              <ArrowLeft size={16} />
            </button>
            <button onClick={handleGoForward} title="Forward">
              <ArrowRight size={16} />
            </button>
            <button onClick={handleReload} title="Reload">
              <RotateCw size={15} />
            </button>
          </div>

          <form className="omnibox-form" onSubmit={handleUrlSubmit}>
            <div className="omnibox-wrapper">
              <span title="uBlock Shield Active"><ShieldCheck size={16} className="shield-icon" /></span>
              <input
                type="text"
                className="omnibox-input"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Search or enter URL..."
              />
              <button type="submit" className="omnibox-go">
                <Search size={15} />
              </button>
            </div>
          </form>

          {/* REMO Agent Sidebar Toggle */}
          <button
            className={`agent-toggle-btn ${isSidebarOpen ? 'active' : ''}`}
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            title="Toggle REMO Agent"
          >
            <Sparkles size={16} className="sparkle-icon" />
            <span>REMO Agent</span>
            {agentStatus.state === 'running' && <span className="running-dot" />}
          </button>
        </div>
      </header>

      {/* ============================================================== */}
      {/* 2. MAIN VIEWPORT: SPLIT BROWSER & SIDEBAR                     */}
      {/* ============================================================== */}
      <main className="browser-main-viewport">
        {/* Left Pane: Embedded Web Engine (<webview>) */}
        <section className={`web-pane ${!isSidebarOpen ? 'full-width' : ''}`}>
          <webview
            ref={webviewRef}
            src={currentTab.url}
            className="embedded-webview"
            partition="persist:remowser"
            allowpopups={true}
          />
        </section>

        {/* Right Pane: REMOWSER AI Sidebar */}
        {isSidebarOpen && (
          <aside className="comet-sidebar">
            {/* Sidebar Header */}
            <div className="sidebar-header">
              <div className="brand">
                <img src="./icon.png" className="brand-sidebar-logo" alt="REMOWSER" onError={(e: any) => { e.currentTarget.src = '../assets/icon.png'; }} />
                <div>
                  <h2 className="brand-title">REMOWSER</h2>
                  <span className="brand-sub">Autonomous AI • {activeModel}</span>
                </div>
              </div>

              {/* Status Ticker */}
              <div className={`status-pill ${agentStatus.state}`}>
                <span className="status-indicator" />
                <span className="status-text">{agentStatus.message}</span>
              </div>
            </div>

            {/* Sidebar Tabs (Chat vs Task Queue) */}
            <div className="sidebar-tabs">
              <button
                className={`sidebar-tab-btn ${activeSidebarTab === 'chat' ? 'active' : ''}`}
                onClick={() => setActiveSidebarTab('chat')}
              >
                Agent Chat
              </button>
              <button
                className={`sidebar-tab-btn ${activeSidebarTab === 'queue' ? 'active' : ''}`}
                onClick={() => setActiveSidebarTab('queue')}
              >
                <ListTodo size={14} />
                <span>Task Queue ({taskQueue.length})</span>
              </button>
            </div>

            {/* ========================================================== */}
            {/* 3. SECURITY BOUNDARY: HUMAN-IN-THE-LOOP INTERCEPTOR CARD   */}
            {/* ========================================================== */}
            {verificationData && (
              <div className="hitl-banner">
                <div className="hitl-header">
                  <AlertTriangle size={18} className="alert-icon" />
                  <h4>Security Checkpoint</h4>
                </div>
                <p className="hitl-reason">{verificationData.reason}</p>
                <p className="hitl-hint">
                  The active page has been surfaced to your browser window. Please complete the captcha or verification, then resume REMO.
                </p>
                <div className="hitl-actions">
                  <button className="hitl-approve-btn" onClick={handleApproveResume}>
                    <Play size={14} />
                    Approve / Resume Agent
                  </button>
                  <button className="hitl-cancel-btn" onClick={handleCancelTask}>
                    <Square size={13} />
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* ========================================================== */}
            {/* 4. CHAT LOG / THOUGHT STREAM                               */}
            {/* ========================================================== */}
            {activeSidebarTab === 'chat' ? (
              <div className="chat-container">
                {messages.map((msg) => (
                  <div key={msg.id} className={`chat-message ${msg.sender}`}>
                    <div className="msg-avatar">
                      {msg.sender === 'user' ? <User size={14} /> : <Bot size={14} />}
                    </div>
                    <div className="msg-bubble">
                      <div className="msg-text">{msg.text}</div>
                      {msg.extractedData && (
                        <div className="extracted-data-card">
                          <div className="extracted-title">
                            <ExternalLink size={13} />
                            <span>{msg.extractedData.target}</span>
                          </div>
                          <pre className="extracted-content">{msg.extractedData.content}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            ) : (
              /* ========================================================== */
              /* 5. AGENT TASK QUEUE                                        */
              /* ========================================================== */
              <div className="queue-container">
                {taskQueue.length === 0 ? (
                  <div className="empty-queue">No tasks in queue. Submit a task below!</div>
                ) : (
                  taskQueue.map((item) => (
                    <div key={item.id} className={`queue-card ${item.status}`}>
                      <div className="queue-header">
                        <span className="queue-prompt">"{item.prompt}"</span>
                        <span className={`queue-badge ${item.status}`}>{item.status}</span>
                      </div>
                      {item.currentStep && (
                        <div className="queue-step">{item.currentStep}</div>
                      )}
                      {item.result && (
                        <div className="queue-result">
                          <CheckCircle2 size={13} />
                          <span>{item.result}</span>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ========================================================== */}
            {/* 6. INPUT PROMPT & QUICK TASK CHIPS                         */}
            {/* ========================================================== */}
            <div className="sidebar-footer">
              <div className="suggestion-chips">
                <button onClick={() => setPrompt('Find the best price for RTX 4070 on Newegg')}>
                  🛒 Price Check
                </button>
                <button onClick={() => setPrompt('What are the top 3 stories on Hacker News today?')}>
                  📰 HN Top Stories
                </button>
                <button onClick={() => setPrompt('Search weather in Tokyo')}>
                  ⛅ Weather
                </button>
              </div>

              <div className="prompt-input-wrapper">
                <textarea
                  className="prompt-textarea"
                  rows={2}
                  placeholder="Ask REMO to research, browse, click, or extract..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmitTask();
                    }
                  }}
                />
                <button
                  className="send-btn"
                  onClick={handleSubmitTask}
                  disabled={!prompt.trim() || agentStatus.state === 'running'}
                  title="Send to REMO"
                >
                  <Sparkles size={16} />
                </button>
              </div>

              <div className="model-indicator">
                <span className="model-dot" />
                <span>REMO Engine Active • Local {activeModel} @ 11434</span>
              </div>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
};

export default App;
