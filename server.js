import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Serve production build
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Persistence ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data', 'rooms');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveRoomToDisk(code, state) {
  try {
    const filePath = path.join(DATA_DIR, `${code}.json`);
    const saveData = {
      code,
      savedAt: new Date().toISOString(),
      tracks: state.tracks,
      stations: state.stations,
      trains: state.trains,
      signals: state.signals,
      junctions: state.junctions || {},
      simulation: state.simulation,
    };
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to save room ${code}:`, err.message);
    return false;
  }
}

function loadRoomFromDisk(code) {
  try {
    const filePath = path.join(DATA_DIR, `${code}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`  ✗ Failed to load room ${code}:`, err.message);
    return null;
  }
}

function deleteRoomFromDisk(code) {
  try {
    const filePath = path.join(DATA_DIR, `${code}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`  ✗ Failed to delete room ${code}:`, err.message);
  }
}

function listSavedRooms() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8');
        const data = JSON.parse(raw);
        return {
          code: data.code,
          savedAt: data.savedAt,
          trackCount: Object.keys(data.tracks || {}).length,
          stationCount: Object.keys(data.stations || {}).length,
          trainCount: Object.keys(data.trains || {}).length,
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ─── Room Storage (in-memory, synced to disk) ────────────────
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
    junctions: {},
    simulation: { playing: false, speed: 1 },
    users: {},
    _dirty: false,
    _lastSave: Date.now(),
  };
}

/** Get or restore a room from disk into memory */
function getOrRestoreRoom(code) {
  if (rooms.has(code)) return rooms.get(code);

  // Try loading from disk
  const saved = loadRoomFromDisk(code);
  if (saved) {
    const state = createRoomState();
    state.tracks = saved.tracks || {};
    state.stations = saved.stations || {};
    state.trains = saved.trains || {};
    state.signals = saved.signals || {};
    state.junctions = saved.junctions || {};
    if (saved.simulation) {
      state.simulation = { ...saved.simulation, playing: false };
    }
    rooms.set(code, state);
    console.log(`  📂 Restored room ${code} from disk`);
    return state;
  }
  return null;
}

// Auto-save dirty rooms every 15 seconds
setInterval(() => {
  for (const [code, state] of rooms) {
    if (state._dirty) {
      saveRoomToDisk(code, state);
      state._dirty = false;
      state._lastSave = Date.now();
    }
  }
}, 15000);

// ─── REST API ────────────────────────────────────────────────

// List all saved rooms
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: listSavedRooms() });
});

// Get a specific room's saved state
app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const state = getOrRestoreRoom(code);
  if (!state) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    code,
    tracks: state.tracks,
    stations: state.stations,
    trains: state.trains,
    signals: state.signals,
    junctions: state.junctions,
    simulation: state.simulation,
    userCount: Object.keys(state.users).length,
  });
});

// Force save a room
app.post('/api/rooms/:code/save', (req, res) => {
  const code = req.params.code.toUpperCase();
  const state = rooms.get(code);
  if (!state) {
    return res.status(404).json({ error: 'Room not found or not active' });
  }
  const ok = saveRoomToDisk(code, state);
  state._dirty = false;
  res.json({ success: ok, savedAt: new Date().toISOString() });
});

// Delete a room
app.delete('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  rooms.delete(code);
  deleteRoomFromDisk(code);
  res.json({ success: true });
});

// Check if a room exists (for URL-based auto-join)
app.get('/api/rooms/:code/exists', (req, res) => {
  const code = req.params.code.toUpperCase();
  const inMemory = rooms.has(code);
  const onDisk = fs.existsSync(path.join(DATA_DIR, `${code}.json`));
  res.json({ exists: inMemory || onDisk, code });
});

// ─── Socket.IO Connection Handling ───────────────────────────
io.on('connection', (socket) => {
  console.log(`✦ User connected: ${socket.id}`);

  let currentRoom = null;
  let userName = 'Anonymous';
  const userColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`;

  // ── Create Room ──
  socket.on('create-room', (data, callback) => {
    let roomCode = generateRoomCode();
    while (rooms.has(roomCode) || fs.existsSync(path.join(DATA_DIR, `${roomCode}.json`))) {
      roomCode = generateRoomCode();
    }

    const state = createRoomState();
    rooms.set(roomCode, state);

    userName = data?.name || 'Anonymous';
    currentRoom = roomCode;
    socket.join(roomCode);

    state.users[socket.id] = { name: userName, color: userColor, cursor: null };

    // Save immediately to persist the room
    saveRoomToDisk(roomCode, state);

    callback({ roomCode, state: sanitizeState(state), userId: socket.id, userColor });
    console.log(`  Room created: ${roomCode} by ${userName}`);
  });

  // ── Join Room (supports restoring from disk) ──
  socket.on('join-room', (data, callback) => {
    const { roomCode, name } = data;
    const code = roomCode?.toUpperCase();
    
    // Try in-memory first, then disk
    let state = getOrRestoreRoom(code);

    if (!state) {
      callback({ error: 'Room not found. Check the code and try again.' });
      return;
    }

    userName = name || 'Anonymous';
    currentRoom = code;
    socket.join(code);

    state.users[socket.id] = { name: userName, color: userColor, cursor: null };

    callback({ roomCode: code, state: sanitizeState(state), userId: socket.id, userColor });
    socket.to(code).emit('user-joined', {
      id: socket.id,
      name: userName,
      color: userColor,
    });
    console.log(`  ${userName} joined room ${code}`);
  });

  // ── Operation (track/station/train/signal/junction CRUD) ──
  socket.on('operation', (op) => {
    if (!currentRoom) return;
    const state = rooms.get(currentRoom);
    if (!state) return;

    applyOperation(state, op);
    state._dirty = true;
    socket.to(currentRoom).emit('operation', { ...op, _from: socket.id });
  });

  // ── Cursor Move ──
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
      state._dirty = true;
      socket.to(currentRoom).emit('simulation-control', data);
    }
  });

  // ── Save Room (explicit trigger from client) ──
  socket.on('save-room', (callback) => {
    if (!currentRoom) { callback?.({ error: 'Not in a room' }); return; }
    const state = rooms.get(currentRoom);
    if (!state) { callback?.({ error: 'Room not found' }); return; }
    
    const ok = saveRoomToDisk(currentRoom, state);
    state._dirty = false;
    callback?.({ success: ok, savedAt: new Date().toISOString() });
    
    // Notify all users in room
    io.to(currentRoom).emit('room-saved', { savedAt: new Date().toISOString() });
    console.log(`  💾 Room ${currentRoom} saved by ${userName}`);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`✧ User disconnected: ${socket.id} (${userName})`);
    if (currentRoom) {
      const state = rooms.get(currentRoom);
      if (state) {
        delete state.users[socket.id];
        socket.to(currentRoom).emit('user-left', { id: socket.id });

        // Auto-save when last user leaves, but DON'T delete the room
        if (Object.keys(state.users).length === 0) {
          saveRoomToDisk(currentRoom, state);
          state._dirty = false;
          console.log(`  💾 Room ${currentRoom} auto-saved (last user left)`);
          
          // Remove from memory after 5 minutes of inactivity (stays on disk)
          const roomCode = currentRoom;
          setTimeout(() => {
            const s = rooms.get(roomCode);
            if (s && Object.keys(s.users).length === 0) {
              rooms.delete(roomCode);
              console.log(`  🧹 Room ${roomCode} unloaded from memory (saved on disk)`);
            }
          }, 300000); // 5 minutes
        }
      }
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────

/** Remove internal fields before sending state to clients */
function sanitizeState(state) {
  return {
    tracks: state.tracks,
    stations: state.stations,
    trains: state.trains,
    signals: state.signals,
    junctions: state.junctions || {},
    simulation: state.simulation,
    users: state.users,
  };
}

/** Apply Operation to Server State */
function applyOperation(state, op) {
  const { type, data } = op;
  const collections = {
    track: state.tracks,
    station: state.stations,
    train: state.trains,
    signal: state.signals,
    junction: state.junctions,
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

// ─── SPA Fallback (production) — serve index.html for /room/:code URLs ──
app.get('/room/:code', (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run `npm run build` first');
  });
});

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run `npm run build` first');
  });
});

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚂 RailForge server running on http://localhost:${PORT}`);
  console.log(`  📂 Room data stored in: ${DATA_DIR}\n`);
});
