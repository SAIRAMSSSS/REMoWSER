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
  Globe,
  Compass,
  Copy,
  Check
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
    { id: 'tab_1', title: 'New Tab', url: 'remowser://home' }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab_1');
  const [urlInput, setUrlInput] = useState<string>('');
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [activeSidebarTab, setActiveSidebarTab] = useState<'chat' | 'queue'>('chat');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Agent & Task State
  const [prompt, setPrompt] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'remo',
      text: '👋 Welcome to **REMOWSER**! I am your autonomous on-device AI browser agent. Ask me to research, search Google, compare prices, summarize news, or automate any multi-step task.',
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
  const isHomePage = currentTab.url === 'remowser://home';

  // Fetch available models on load
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
        navigateWebview(data.url);
      }
    });

    const unsubNav = window.remowser.onBrowserNavigate((url) => {
      if (url && url !== 'about:blank') {
        setUrlInput(url);
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url, title: url.replace(/^https?:\/\//, '').split('/')[0] } : t));
      }
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
      if (e.url && e.url !== 'about:blank') {
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
  }, [activeTabId, currentTab.url]);

  // Browser Navigation Actions
  const navigateWebview = (targetUrl: string) => {
    let finalUrl = targetUrl.trim();
    if (!finalUrl) return;

    if (finalUrl === 'remowser://home' || finalUrl === 'about:home' || finalUrl === 'about:blank') {
      finalUrl = 'remowser://home';
      setUrlInput('');
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: 'remowser://home', title: 'New Tab' } : t));
      return;
    }

    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?$/.test(finalUrl)) {
        finalUrl = `https://${finalUrl}`;
      } else {
        // Direct Google search (never DuckDuckGo)
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    }

    setUrlInput(finalUrl);
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: finalUrl, title: finalUrl.replace(/^https?:\/\//, '').split('/')[0] } : t));

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
      url: 'remowser://home'
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
    setUrlInput('');
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) {
      navigateWebview('remowser://home');
      return;
    }
    const remaining = tabs.filter(t => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining[0].id);
      setUrlInput(remaining[0].url === 'remowser://home' ? '' : remaining[0].url);
    }
  };

  // Agent Task Submission
  const handleSubmitTask = async (customPrompt?: string) => {
    const textToSubmit = (customPrompt || prompt).trim();
    if (!textToSubmit || !window.remowser) return;
    setPrompt('');
    setActiveSidebarTab('chat');
    await window.remowser.submitPrompt(textToSubmit);
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

  const handleCopyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="remowser-root">
      {/* ============================================================== */}
      {/* 1. TOP BROWSER CHROME: TABS & TOOLBAR                          */}
      {/* ============================================================== */}
      <header className="browser-chrome">
        <div className="tabs-container">
          <div className="browser-brand-chip">
            <img
              src="./icon.png"
              className="app-header-logo"
              alt="REMOWSER"
              onError={(e: any) => { e.currentTarget.src = '../assets/icon.png'; }}
            />
            <span className="browser-brand-text">REMOWSER</span>
          </div>

          <div className="tab-list">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`browser-tab ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setUrlInput(tab.url === 'remowser://home' ? '' : tab.url);
                }}
              >
                {tab.url === 'remowser://home' ? (
                  <Compass size={14} className="tab-icon" />
                ) : (
                  <Globe size={14} className="tab-icon" />
                )}
                <span className="tab-title">{tab.title || 'New Tab'}</span>
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
          </div>

          <button className="new-tab-btn" onClick={handleNewTab} title="New Tab">
            <Plus size={16} />
          </button>
        </div>

        {/* Omnibox & Navigation Toolbar */}
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
              <span title="Built-in Ad & Tracker Blocker Active">
                <ShieldCheck size={16} className="shield-icon" />
              </span>
              <input
                type="text"
                className="omnibox-input"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Search Google or enter any website address..."
              />
              <button type="submit" className="omnibox-go" title="Navigate">
                <Search size={15} />
              </button>
            </div>
          </form>

          {/* REMO Agent Sidebar Toggle */}
          <button
            className={`agent-toggle-btn ${isSidebarOpen ? 'active' : ''}`}
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            title="Toggle REMO Autonomous Agent"
          >
            <Sparkles size={16} className="sparkle-icon" />
            <span>REMO Agent</span>
            {agentStatus.state === 'running' && <span className="running-dot" />}
          </button>
        </div>
      </header>

      {/* ============================================================== */}
      {/* 2. MAIN VIEWPORT: SPLIT BROWSER & AGENT SIDEBAR               */}
      {/* ============================================================== */}
      <main className="browser-main-viewport">
        {/* Left Pane: Embedded Web Engine (<webview>) OR Home Dashboard */}
        <section className={`web-pane ${!isSidebarOpen ? 'full-width' : ''}`}>
          {isHomePage ? (
            /* ========================================================== */
            /* ELEGANT HOME DASHBOARD (NO DUCKDUCKGO)                     */
            /* ========================================================== */
            <div className="home-dashboard">
              <div className="home-hero">
                <div className="home-logo-wrap">
                  <img
                    src="./icon.png"
                    className="home-hero-logo"
                    alt="REMOWSER"
                    onError={(e: any) => { e.currentTarget.src = '../assets/icon.png'; }}
                  />
                  <div className="home-logo-glow" />
                </div>
                <h1 className="home-title">REMOWSER</h1>
                <p className="home-subtitle">Autonomous Local AI Browser</p>

                {/* Centered Search Bar */}
                <form className="home-search-form" onSubmit={handleUrlSubmit}>
                  <div className="home-search-box">
                    <Search size={18} className="home-search-icon" />
                    <input
                      type="text"
                      className="home-search-input"
                      placeholder="Search Google or enter URL..."
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      autoFocus
                    />
                    <button type="submit" className="home-search-btn">
                      Search
                    </button>
                  </div>
                </form>

                {/* Quick Access Tiles */}
                <div className="quick-access-grid">
                  <div className="quick-tile" onClick={() => navigateWebview('https://www.google.com')}>
                    <span className="tile-icon">🔍</span>
                    <span className="tile-name">Google</span>
                  </div>
                  <div className="quick-tile" onClick={() => navigateWebview('https://www.youtube.com')}>
                    <span className="tile-icon">▶️</span>
                    <span className="tile-name">YouTube</span>
                  </div>
                  <div className="quick-tile" onClick={() => navigateWebview('https://www.github.com')}>
                    <span className="tile-icon">🐙</span>
                    <span className="tile-name">GitHub</span>
                  </div>
                  <div className="quick-tile" onClick={() => navigateWebview('https://www.reddit.com')}>
                    <span className="tile-icon">💬</span>
                    <span className="tile-name">Reddit</span>
                  </div>
                  <div className="quick-tile" onClick={() => navigateWebview('https://www.wikipedia.org')}>
                    <span className="tile-icon">📖</span>
                    <span className="tile-name">Wikipedia</span>
                  </div>
                  <div className="quick-tile" onClick={() => navigateWebview('https://news.ycombinator.com')}>
                    <span className="tile-icon">📰</span>
                    <span className="tile-name">Hacker News</span>
                  </div>
                  <div className="quick-tile" onClick={() => navigateWebview('https://www.amazon.com')}>
                    <span className="tile-icon">📦</span>
                    <span className="tile-name">Amazon</span>
                  </div>
                </div>

                {/* AI Agent Quick Starters */}
                <div className="home-ai-starters">
                  <div className="ai-starter-header">
                    <Sparkles size={14} className="sparkle-icon" />
                    <span>Try asking REMO Agent:</span>
                  </div>
                  <div className="ai-starter-chips">
                    <button onClick={() => handleSubmitTask('Search for RTX 4070 prices on Google and summarize the best deal')}>
                      💰 "Find best RTX 4070 price"
                    </button>
                    <button onClick={() => handleSubmitTask('Open YouTube and find relaxing lofi music')}>
                      🎧 "Find lofi music on YouTube"
                    </button>
                    <button onClick={() => handleSubmitTask('Summarize the top stories on Hacker News')}>
                      📰 "Top Hacker News stories"
                    </button>
                    <button onClick={() => handleSubmitTask('Search Wikipedia for Quantum Computing')}>
                      🧠 "Quantum Computing summary"
                    </button>
                  </div>
                </div>

                {/* System Badge */}
                <div className="home-footer-badge">
                  <span className="badge-dot" />
                  <span>REMO Autonomous Engine Active • {activeModel} @ 11434 • AdBlock 🛡️ Active</span>
                </div>
              </div>
            </div>
          ) : (
            <webview
              ref={webviewRef}
              src={currentTab.url}
              className="embedded-webview"
              partition="persist:remowser"
              allowpopups={true}
            />
          )}
        </section>

        {/* Right Pane: Autonomous AI Sidebar */}
        {isSidebarOpen && (
          <aside className="comet-sidebar">
            {/* Sidebar Header */}
            <div className="sidebar-header">
              <div className="brand">
                <img
                  src="./icon.png"
                  className="brand-sidebar-logo"
                  alt="REMOWSER"
                  onError={(e: any) => { e.currentTarget.src = '../assets/icon.png'; }}
                />
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

            {/* Sidebar Tabs */}
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
            {/* 3. SECURITY BOUNDARY: HUMAN ACTION REQUIRED BANNER         */}
            {/* ========================================================== */}
            {verificationData && (
              <div className="hitl-banner">
                <div className="hitl-header">
                  <AlertTriangle size={18} className="alert-icon" />
                  <h4>Security Checkpoint</h4>
                </div>
                <p className="hitl-reason">{verificationData.reason}</p>
                <p className="hitl-hint">
                  The page is displayed in your browser. Complete the captcha or login, then click Resume below.
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
            {/* 4. CHAT STREAM / AGENT LOGS                                */}
            {/* ========================================================== */}
            {activeSidebarTab === 'chat' ? (
              <div className="chat-container">
                {messages.map((msg) => (
                  <div key={msg.id} className={`chat-message ${msg.sender}`}>
                    <div className="msg-avatar">
                      {msg.sender === 'user' ? (
                        <User size={14} />
                      ) : (
                        <img
                          src="./icon.png"
                          className="msg-avatar-img"
                          alt="REMO"
                          onError={(e: any) => { e.currentTarget.src = '../assets/icon.png'; }}
                        />
                      )}
                    </div>
                    <div className="msg-bubble">
                      <div className="msg-text">{msg.text}</div>
                      {msg.extractedData && (
                        <div className="extracted-data-card">
                          <div className="extracted-header">
                            <div className="extracted-title">
                              <ExternalLink size={13} />
                              <span>{msg.extractedData.target}</span>
                            </div>
                            <button
                              className="copy-btn"
                              onClick={() => handleCopyText(msg.extractedData!.content, msg.id)}
                              title="Copy extracted text"
                            >
                              {copiedId === msg.id ? <Check size={12} /> : <Copy size={12} />}
                            </button>
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
                  <div className="empty-queue">
                    <ListTodo size={32} className="empty-icon" />
                    <p>No active tasks in queue.</p>
                    <span>Submit any research or browsing task below!</span>
                  </div>
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
            {/* 6. PROMPT INPUT & ACTION STARTERS                          */}
            {/* ========================================================== */}
            <div className="sidebar-footer">
              <div className="suggestion-chips">
                <button onClick={() => handleSubmitTask('Search for RTX 4070 prices on Google and find the lowest price')}>
                  💰 GPU Prices
                </button>
                <button onClick={() => handleSubmitTask('Open YouTube and search relaxing lofi music')}>
                  🎵 Lofi Music
                </button>
                <button onClick={() => handleSubmitTask('Find the top 3 tech stories on Hacker News')}>
                  📰 Top News
                </button>
                <button onClick={() => handleSubmitTask('Check weather in Tokyo')}>
                  ⛅ Weather
                </button>
              </div>

              <div className="prompt-input-wrapper">
                <textarea
                  className="prompt-textarea"
                  rows={2}
                  placeholder="Ask REMO to research, browse, click, or extract anything..."
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
                  onClick={() => handleSubmitTask()}
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
