// src/preload.ts
/**
 * Electron Preload Script
 * Exposes a strictly isolated, secure IPC bridge between Main and Renderer processes.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AgentStatus, TaskItem, ChatMessage, HumanVerificationData } from './types/ipc';

contextBridge.exposeInMainWorld('remowser', {
  submitPrompt: (prompt: string) => ipcRenderer.invoke('submit-prompt', prompt),
  cancelTask: (taskId: string) => ipcRenderer.invoke('cancel-task', taskId),
  resumeAgent: (taskId: string) => ipcRenderer.invoke('resume-agent', taskId),
  getAvailableModels: () => ipcRenderer.invoke('get-models'),

  onAgentStatus: (callback: (status: AgentStatus) => void) => {
    const handler = (_event: any, status: AgentStatus) => callback(status);
    ipcRenderer.on('agent-status', handler);
    return () => ipcRenderer.removeListener('agent-status', handler);
  },

  onTaskQueueUpdate: (callback: (tasks: TaskItem[]) => void) => {
    const handler = (_event: any, tasks: TaskItem[]) => callback(tasks);
    ipcRenderer.on('task-queue-update', handler);
    return () => ipcRenderer.removeListener('task-queue-update', handler);
  },

  onChatMessage: (callback: (msg: ChatMessage) => void) => {
    const handler = (_event: any, msg: ChatMessage) => callback(msg);
    ipcRenderer.on('chat-message', handler);
    return () => ipcRenderer.removeListener('chat-message', handler);
  },

  onHumanVerification: (callback: (data: HumanVerificationData | null) => void) => {
    const handler = (_event: any, data: HumanVerificationData | null) => callback(data);
    ipcRenderer.on('human-verification-required', handler);
    return () => ipcRenderer.removeListener('human-verification-required', handler);
  },

  onBrowserNavigate: (callback: (url: string) => void) => {
    const handler = (_event: any, url: string) => callback(url);
    ipcRenderer.on('browser-navigate-event', handler);
    return () => ipcRenderer.removeListener('browser-navigate-event', handler);
  }
});
