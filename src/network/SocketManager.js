/**
 * SocketManager — Socket.IO client for single shared workspace.
 * No rooms, no login. Just connect and get the workspace.
 */
import { io } from 'socket.io-client';

export class SocketManager {
  constructor(appState) {
    this.app = appState;
    this.socket = null;
    this.connected = false;
    this.userId = null;
    this.userColor = null;
    this.userName = null;
  }

  /** Connect to the server and receive workspace state */
  connect() {
    return new Promise((resolve) => {
      this.socket = io({ transports: ['websocket', 'polling'] });

      this.socket.on('connect', () => {
        this.connected = true;
      });

      this.socket.on('disconnect', () => {
        this.connected = false;
        this.app.notify?.('Disconnected from server', 'warning');
      });

      // ── Receive full workspace state on connect ──
      this.socket.on('workspace-state', (data) => {
        this.userId = data.userId;
        this.userColor = data.userColor;
        this.userName = data.userName;
        this.app.loadWorkspaceState?.(data);
        resolve(data);
      });

      // ── Incoming operations ──
      this.socket.on('operation', (op) => {
        this.app.applyRemoteOperation?.(op);
      });

      // ── Cursor updates ──
      this.socket.on('cursor-move', (data) => {
        this.app.updateRemoteCursor?.(data);
      });

      // ── User joined ──
      this.socket.on('user-joined', (data) => {
        this.app.addRemoteUser?.(data);
        this.app.notify?.(`${data.name} joined`, 'info');
      });

      // ── User left ──
      this.socket.on('user-left', (data) => {
        this.app.removeRemoteUser?.(data.id);
      });

      // ── User renamed ──
      this.socket.on('user-renamed', (data) => {
        const user = this.app.remoteUsers.get(data.id);
        if (user) user.name = data.name;
      });

      // ── Simulation control ──
      this.socket.on('simulation-control', (data) => {
        this.app.applyRemoteSimControl?.(data);
      });

      // ── Workspace saved ──
      this.socket.on('workspace-saved', (data) => {
        this.app.notify?.(`💾 Saved at ${new Date(data.savedAt).toLocaleTimeString()}`, 'success');
      });
    });
  }

  /** Set display name */
  setName(name) {
    if (this.connected) {
      this.userName = name;
      this.socket.emit('set-name', name);
    }
  }

  /** Send operation */
  sendOperation(type, data) {
    if (!this.connected) return;
    this.socket.emit('operation', { type, data });
  }

  /** Send cursor position */
  sendCursor(pos) {
    if (!this.connected) return;
    this.socket.emit('cursor-move', pos);
  }

  /** Send simulation control */
  sendSimControl(data) {
    if (!this.connected) return;
    this.socket.emit('simulation-control', data);
  }

  /** Save workspace */
  saveWorkspace() {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      this.socket.emit('save-workspace', (response) => {
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  /** Disconnect */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
  }
}
