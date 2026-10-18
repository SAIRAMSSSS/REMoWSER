// src/types/ipc.d.ts
/**
 * Shared IPC channel typings between the Electron main process and the renderer.
 */

export interface AgentCommand {
  action: 'open_tab' | 'switch_tab' | 'click' | 'type' | 'scroll' | 'extract_data' | 'task_complete';
  url?: string;
  tab_id?: string;
  id?: number;
  text?: string;
  direction?: 'up' | 'down';
  target?: string;
  message?: string;
  thought?: string;
}

export interface AgentStatus {
  message: string;
  state: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  step?: number;
  maxSteps?: number;
}

export interface TaskItem {
  id: string;
  prompt: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused';
  createdAt: number;
  result?: string;
  currentStep?: string;
}

export interface HumanVerificationData {
  taskId: string;
  reason: string;
  url: string;
  detectedType: 'captcha' | 'login' | 'checkout' | 'destructive';
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'remo' | 'system';
  text: string;
  timestamp: number;
  actionDetails?: AgentCommand;
  extractedData?: { target: string; content: string };
}

declare global {
  interface Window {
    remowser: {
      submitPrompt(prompt: string): Promise<{ success: boolean; taskId: string; error?: string }>;
      cancelTask(taskId: string): Promise<{ success: boolean }>;
      resumeAgent(taskId: string): Promise<{ success: boolean }>;
      navigateActiveWebview(url: string): Promise<{ success: boolean }>;
      getAvailableModels(): Promise<string[]>;
      onAgentStatus(cb: (status: AgentStatus) => void): () => void;
      onTaskQueueUpdate(cb: (tasks: TaskItem[]) => void): () => void;
      onChatMessage(cb: (msg: ChatMessage) => void): () => void;
      onHumanVerification(cb: (data: HumanVerificationData | null) => void): () => void;
      onBrowserNavigate(cb: (url: string) => void): () => void;
    };
  }
}
