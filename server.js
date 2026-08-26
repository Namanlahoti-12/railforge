import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Serve production build
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Room Storage ────────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoomState() {
  return {
    tracks: {},
    stations: {},
    trains: {},
    signals: {},
    simulation: { playing: false, speed: 1 },
    users: {},
  };
}

// ─── Socket.IO Connection Handling ───────────────────────────
io.on('connection', (socket) => {
  console.log(`✦ User connected: ${socket.id}`);

  let currentRoom = null;
  let userName = 'Anonymous';
  const userColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`;

  // ── Create Room ──
  socket.on('create-room', (data, callback) => {
    let roomCode = generateRoomCode();
    while (rooms.has(roomCode)) roomCode = generateRoomCode();

    const state = createRoomState();
    rooms.set(roomCode, state);

    userName = data?.name || 'Anonymous';
    currentRoom = roomCode;
    socket.join(roomCode);

    state.users[socket.id] = { name: userName, color: userColor, cursor: null };

    callback({ roomCode, state, userId: socket.id, userColor });
    console.log(`  Room created: ${roomCode} by ${userName}`);
  });

  // ── Join Room ──
  socket.on('join-room', (data, callback) => {
    const { roomCode, name } = data;
    const state = rooms.get(roomCode?.toUpperCase());

    if (!state) {
      callback({ error: 'Room not found. Check the code and try again.' });
      return;
    }

    userName = name || 'Anonymous';
    currentRoom = roomCode.toUpperCase();
    socket.join(currentRoom);

    state.users[socket.id] = { name: userName, color: userColor, cursor: null };

    callback({ roomCode: currentRoom, state, userId: socket.id, userColor });
    socket.to(currentRoom).emit('user-joined', {
      id: socket.id,
      name: userName,
      color: userColor,
    });
    console.log(`  ${userName} joined room ${currentRoom}`);
  });

  // ── Operation (track/station/train/signal CRUD) ──
  socket.on('operation', (op) => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    if (!state) return;

    applyOperation(state, op);
    socket.to(currentRoom).emit('operation', { ...op, _from: socket.id });
  });

  // ── Cursor Move (throttled by client) ──
  socket.on('cursor-move', (cursor) => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    if (state?.users[socket.id]) {
      state.users[socket.id].cursor = cursor;
    }
    socket.to(currentRoom).emit('cursor-move', { id: socket.id, ...cursor });
  });

  // ── Simulation Control ──
  socket.on('simulation-control', (data) => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    if (state) {
      Object.assign(state.simulation, data);
      socket.to(currentRoom).emit('simulation-control', data);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`✧ User disconnected: ${socket.id} (${userName})`);
    if (currentRoom) {
      const state = rooms.get(currentRoom);
      if (state) {
        delete state.users[socket.id];
        socket.to(currentRoom).emit('user-left', { id: socket.id });

        // Clean up empty rooms after a delay
        if (Object.keys(state.users).length === 0) {
          setTimeout(() => {
            const s = rooms.get(currentRoom);
            if (s && Object.keys(s.users).length === 0) {
              rooms.delete(currentRoom);
              console.log(`  Room ${currentRoom} deleted (empty)`);
            }
          }, 30000);
        }
      }
    }
  });
});

// ─── Apply Operation to Server State ─────────────────────────
function applyOperation(state, op) {
  const { type, data } = op;
  const collections = {
    track: state.tracks,
    station: state.stations,
    train: state.trains,
    signal: state.signals,
  };

  const [action, entity] = type.split('-'); // e.g. "add-track" → ["add","track"]
  const collection = collections[entity];
  if (!collection) return;

  switch (action) {
    case 'add':
    case 'update':
      collection[data.id] = { ...collection[data.id], ...data };
      break;
    case 'remove':
      delete collection[data.id];
      break;
  }
}

// ─── SPA Fallback (production) ───────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run `npm run build` first');
  });
});

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚂 RailForge server running on http://localhost:${PORT}\n`);
});
