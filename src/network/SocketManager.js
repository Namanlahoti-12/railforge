/**
 * SocketManager — Socket.IO client for real-time collaboration.
 */
import { io } from 'socket.io-client';

export class SocketManager {
  constructor(appState) {
    this.app = appState;
    this.socket = null;
    this.connected = false;
    this.roomCode = null;
    this.userId = null;
    this.userColor = null;
  }

  /** Connect to the Socket.IO server */
  connect() {
    return new Promise((resolve) => {
      // Connect to same origin (proxied by Vite in dev)
      this.socket = io({ transports: ['websocket', 'polling'] });

      this.socket.on('connect', () => {
        this.connected = true;
        resolve();
      });

      this.socket.on('disconnect', () => {
        this.connected = false;
        this.app.notify?.('Disconnected from server', 'warning');
      });

      // ── Incoming operations from other users ──
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
        this.app.notify?.(`${data.name} joined the room`, 'info');
      });

      // ── User left ──
      this.socket.on('user-left', (data) => {
        this.app.removeRemoteUser?.(data.id);
      });

      // ── Simulation control from others ──
      this.socket.on('simulation-control', (data) => {
        this.app.applyRemoteSimControl?.(data);
      });
    });
  }

  /** Create a new room */
  createRoom(name) {
    return new Promise((resolve, reject) => {
      this.socket.emit('create-room', { name }, (response) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        this.roomCode = response.roomCode;
        this.userId = response.userId;
        this.userColor = response.userColor;
        resolve(response);
      });
    });
  }

  /** Join an existing room */
  joinRoom(roomCode, name) {
    return new Promise((resolve, reject) => {
      this.socket.emit('join-room', { roomCode, name }, (response) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        this.roomCode = response.roomCode;
        this.userId = response.userId;
        this.userColor = response.userColor;
        resolve(response);
      });
    });
  }

  /** Send an operation to the server */
  sendOperation(type, data) {
    if (!this.connected || !this.roomCode) return;
    this.socket.emit('operation', { type, data });
  }

  /** Send cursor position */
  sendCursor(pos) {
    if (!this.connected || !this.roomCode) return;
    this.socket.emit('cursor-move', pos);
  }

  /** Send simulation control */
  sendSimControl(data) {
    if (!this.connected || !this.roomCode) return;
    this.socket.emit('simulation-control', data);
  }

  /** Disconnect */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.roomCode = null;
  }
}
