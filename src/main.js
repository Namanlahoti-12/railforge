/**
 * main.js — RailForge Application Orchestrator
 * Wires together all modules: engine, objects, simulation, network, UI.
 */
import { Camera } from './engine/Camera.js';
import { Grid } from './engine/Grid.js';
import { Renderer } from './engine/Renderer.js';
import { InputHandler } from './engine/InputHandler.js';
import { Track, dist, canConnect } from './objects/Track.js';
import { Station } from './objects/Station.js';
import { Train, TRAIN_COLORS } from './objects/Train.js';
import { Signal } from './objects/Signal.js';
import { SimulationEngine } from './simulation/SimulationEngine.js';
import { PathFinder } from './simulation/PathFinder.js';
import { SocketManager } from './network/SocketManager.js';

// ═══════════════════════════════════════════════════════════
//  App State
// ═══════════════════════════════════════════════════════════
const app = {
  tracks: new Map(),
  stations: new Map(),
  trains: new Map(),
  signals: new Map(),

  activeTool: 'select',
  selectedElement: null,  // { type: 'track'|'station'|'train'|'signal', id }
  hoverElement: null,

  // Building state
  _buildState: null,  // tool-specific temp state

  // Remote users
  remoteUsers: new Map(), // id → { name, color, cursor }

  // Undo stack
  _undoStack: [],
  _maxUndo: 50,
};

// ═══════════════════════════════════════════════════════════
//  Initialize Modules
// ═══════════════════════════════════════════════════════════
const canvas = document.getElementById('main-canvas');
const camera = new Camera(canvas);
const grid = new Grid();
const renderer = new Renderer(canvas, camera, grid);
const input = new InputHandler(canvas, camera, grid, app);
const simulation = new SimulationEngine(app);
const pathFinder = new PathFinder();
const socket = new SocketManager(app);

let trainCounter = 1;
let stationCounter = 1;

// ═══════════════════════════════════════════════════════════
//  App Methods (called by InputHandler)
// ═══════════════════════════════════════════════════════════

app.setTool = (tool) => {
  app.activeTool = tool;
  app._buildState = null;
  app.selectedElement = null;
  updateToolbarUI();
  updatePropertiesPanel();
  updatePreviewHint();

  const container = document.getElementById('canvas-container');
  container.className = `tool-${tool}`;
};

app.handleToolClick = (snapped, world) => {
  const tool = app.activeTool;

  switch (tool) {
    case 'select': return handleSelectClick(world);
    case 'straight-track': return handleStraightTrackClick(snapped);
    case 'curved-track': return handleCurvedTrackClick(snapped);
    case 'station': return handleStationClick(snapped, world);
    case 'train': return handleTrainClick(world);
    case 'signal': return handleSignalClick(world);
    case 'eraser': return handleEraserClick(world);
  }
};

app.handleToolMove = (snapped, world) => {
  // Hover detection
  app.hoverElement = findElementAt(world);

  // Update build previews
  if (app.activeTool === 'straight-track' && app._buildState?.start) {
    app._buildState.previewEnd = snapped;
  }
  if (app.activeTool === 'curved-track' && app._buildState) {
    if (app._buildState.phase === 'end') {
      app._buildState.previewEnd = snapped;
    } else if (app._buildState.phase === 'control') {
      app._buildState.previewCP = snapped;
    }
  }
};

app.handleToolRelease = () => {};

app.handleToolDoubleClick = (world) => {
  if (app.activeTool === 'select') {
    const elem = findElementAt(world);
    if (elem?.type === 'station') {
      const station = app.stations.get(elem.id);
      if (station) {
        const name = prompt('Station name:', station.name);
        if (name) {
          station.name = name;
          sendOp('update-station', station.toJSON());
          updatePropertiesPanel();
        }
      }
    }
  }
};

app.cancelCurrentAction = () => {
  app._buildState = null;
  updatePreviewHint();
};

app.deleteSelected = () => {
  if (!app.selectedElement) return;
  const { type, id } = app.selectedElement;

  switch (type) {
    case 'track':
      app.tracks.delete(id);
      sendOp('remove-track', { id });
      // Remove associated stations and signals
      for (const [sid, s] of app.stations) {
        if (s.trackId === id) { app.stations.delete(sid); sendOp('remove-station', { id: sid }); }
      }
      break;
    case 'station':
      app.stations.delete(id);
      sendOp('remove-station', { id });
      break;
    case 'train':
      app.trains.delete(id);
      sendOp('remove-train', { id });
      break;
    case 'signal':
      app.signals.delete(id);
      sendOp('remove-signal', { id });
      break;
  }
  app.selectedElement = null;
  updatePropertiesPanel();
};

app.toggleSimulation = () => {
  if (simulation.playing) {
    simulation.pause();
    socket.sendSimControl({ playing: false });
  } else {
    simulation.play();
    socket.sendSimControl({ playing: true, speed: simulation.speed });
  }
  updateSimButtons();
};

app.undo = () => {
  if (app._undoStack.length === 0) return;
  const action = app._undoStack.pop();
  if (action.type === 'add-track') {
    app.tracks.delete(action.data.id);
    sendOp('remove-track', { id: action.data.id });
  }
  // Could extend for other types
};

app.broadcastCursor = (world) => {
  socket.sendCursor({ x: world.x, y: world.y });
};

app.notify = (message, type = 'info') => {
  showNotification(message, type);
};

// ── Remote operation handlers ──
app.applyRemoteOperation = (op) => {
  const { type, data } = op;
  switch (type) {
    case 'add-track':
    case 'update-track': {
      const t = new Track(data);
      app.tracks.set(t.id, t);
      break;
    }
    case 'remove-track':
      app.tracks.delete(data.id);
      break;
    case 'add-station':
    case 'update-station': {
      const s = new Station(data);
      app.stations.set(s.id, s);
      break;
    }
    case 'remove-station':
      app.stations.delete(data.id);
      break;
    case 'add-train':
    case 'update-train': {
      const tr = new Train(data);
      app.trains.set(tr.id, tr);
      break;
    }
    case 'remove-train':
      app.trains.delete(data.id);
      break;
    case 'add-signal':
    case 'update-signal': {
      const sig = new Signal(data);
      app.signals.set(sig.id, sig);
      break;
    }
    case 'remove-signal':
      app.signals.delete(data.id);
      break;
  }
};

app.updateRemoteCursor = (data) => {
  const user = app.remoteUsers.get(data.id);
  if (user) {
    user.cursor = { x: data.x, y: data.y };
  }
};

app.addRemoteUser = (data) => {
  app.remoteUsers.set(data.id, { name: data.name, color: data.color, cursor: null });
  updateUsersUI();
};

app.removeRemoteUser = (id) => {
  const user = app.remoteUsers.get(id);
  if (user) {
    app.notify?.(`${user.name} left the room`, 'info');
  }
  app.remoteUsers.delete(id);
  updateUsersUI();
};

app.applyRemoteSimControl = (data) => {
  if (data.playing !== undefined) {
    if (data.playing) simulation.play(); else simulation.pause();
  }
  if (data.speed !== undefined) {
    simulation.setSpeed(data.speed);
    document.getElementById('sim-speed-slider').value = data.speed;
    document.getElementById('sim-speed-value').textContent = `${data.speed}×`;
  }
  updateSimButtons();
};

// ═══════════════════════════════════════════════════════════
//  Tool Handlers
// ═══════════════════════════════════════════════════════════

function handleSelectClick(world) {
  const elem = findElementAt(world);
  app.selectedElement = elem;
  updatePropertiesPanel();
}

function handleStraightTrackClick(snapped) {
  if (!app._buildState) {
    // Check for snap to existing endpoint
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState = { start: snapPt || snapped, previewEnd: snapped };
    updatePreviewHint('Click to place end point • Right-click to cancel');
  } else {
    const snapPt = findNearEndpoint(snapped, 25);
    const end = snapPt || snapped;
    const start = app._buildState.start;

    if (dist(start, end) < 10) return; // too short

    const track = new Track({
      type: 'straight',
      start: { ...start },
      end: { ...end },
    });

    // Auto-connect
    autoConnect(track);

    app.tracks.set(track.id, track);
    sendOp('add-track', track.toJSON());
    pushUndo({ type: 'add-track', data: track.toJSON() });

    app._buildState = null;
    updatePreviewHint();
    app.notify('Track placed', 'success');
  }
}

function handleCurvedTrackClick(snapped) {
  if (!app._buildState) {
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState = { phase: 'end', start: snapPt || snapped, previewEnd: snapped };
    updatePreviewHint('Click to place end point');
  } else if (app._buildState.phase === 'end') {
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState.end = snapPt || snapped;
    app._buildState.phase = 'control';
    app._buildState.previewCP = snapped;
    updatePreviewHint('Click to set curve control point');
  } else if (app._buildState.phase === 'control') {
    const { start, end } = app._buildState;
    const cp = snapped;

    // Create symmetric control points from single midpoint
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const dx = cp.x - midX;
    const dy = cp.y - midY;

    const track = new Track({
      type: 'curve',
      start: { ...start },
      end: { ...end },
      cp1: { x: start.x + dx, y: start.y + dy },
      cp2: { x: end.x + dx, y: end.y + dy },
    });

    autoConnect(track);

    app.tracks.set(track.id, track);
    sendOp('add-track', track.toJSON());
    pushUndo({ type: 'add-track', data: track.toJSON() });

    app._buildState = null;
    updatePreviewHint();
    app.notify('Curved track placed', 'success');
  }
}

function handleStationClick(snapped, world) {
  // Find nearest track to place station on
  let bestTrack = null;
  let bestDist = 50; // max distance to snap to a track
  let bestT = 0;

  for (const [, track] of app.tracks) {
    const t = track.closestT(world.x, world.y);
    const p = track.getPointAt(t);
    const d = dist(world, p);
    if (d < bestDist) {
      bestDist = d;
      bestTrack = track;
      bestT = t;
    }
  }

  if (!bestTrack) {
    app.notify('Place station near a track segment', 'warning');
    return;
  }

  const station = new Station({
    name: `Station ${stationCounter++}`,
    trackId: bestTrack.id,
    trackT: bestT,
    color: '#4e8cff',
  });

  station.updateFromTrack(bestTrack);

  app.stations.set(station.id, station);
  sendOp('add-station', station.toJSON());
  app.notify(`${station.name} placed`, 'success');
}

function handleTrainClick(world) {
  // Find nearest track
  let bestTrack = null;
  let bestDist = 50;
  let bestT = 0;

  for (const [, track] of app.tracks) {
    const t = track.closestT(world.x, world.y);
    const p = track.getPointAt(t);
    const d = dist(world, p);
    if (d < bestDist) {
      bestDist = d;
      bestTrack = track;
      bestT = t;
    }
  }

  if (!bestTrack) {
    app.notify('Place train near a track segment', 'warning');
    return;
  }

  // Build route from connected tracks
  const connectedRoute = pathFinder.getConnectedTracks(bestTrack.id, app.tracks);
  if (!connectedRoute.includes(bestTrack.id)) connectedRoute.unshift(bestTrack.id);

  const train = new Train({
    name: `Train ${trainCounter++}`,
    currentTrackId: bestTrack.id,
    t: bestT,
    speed: 60,
    route: connectedRoute,
    routeIndex: connectedRoute.indexOf(bestTrack.id),
    color: TRAIN_COLORS[(trainCounter - 1) % TRAIN_COLORS.length],
  });

  train.updatePosition(bestTrack);

  app.trains.set(train.id, train);
  sendOp('add-train', train.toJSON());
  app.notify(`${train.name} placed`, 'success');
}

function handleSignalClick(world) {
  let bestTrack = null;
  let bestDist = 50;
  let bestT = 0;

  for (const [, track] of app.tracks) {
    const t = track.closestT(world.x, world.y);
    const p = track.getPointAt(t);
    const d = dist(world, p);
    if (d < bestDist) {
      bestDist = d;
      bestTrack = track;
      bestT = t;
    }
  }

  if (!bestTrack) {
    app.notify('Place signal near a track segment', 'warning');
    return;
  }

  const signal = new Signal({
    trackId: bestTrack.id,
    trackT: bestT,
    state: 'green',
  });

  signal.updateFromTrack(bestTrack);

  app.signals.set(signal.id, signal);
  sendOp('add-signal', signal.toJSON());
  app.notify('Signal placed', 'success');
}

function handleEraserClick(world) {
  const elem = findElementAt(world);
  if (elem) {
    app.selectedElement = elem;
    app.deleteSelected();
    app.notify('Element deleted', 'info');
  }
}

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════

function findElementAt(world) {
  // Check trains first (topmost)
  for (const [id, train] of app.trains) {
    if (train.hitTest(world.x, world.y)) return { type: 'train', id };
  }
  // Then stations
  for (const [id, station] of app.stations) {
    if (station.hitTest(world.x, world.y)) return { type: 'station', id };
  }
  // Then signals
  for (const [id, signal] of app.signals) {
    if (signal.hitTest(world.x, world.y)) return { type: 'signal', id };
  }
  // Then tracks
  for (const [id, track] of app.tracks) {
    if (track.hitTest(world.x, world.y, 12)) return { type: 'track', id };
  }
  return null;
}

function findNearEndpoint(point, threshold) {
  for (const [, track] of app.tracks) {
    if (dist(point, track.start) < threshold) return { ...track.start };
    if (dist(point, track.end) < threshold) return { ...track.end };
  }
  return null;
}

function autoConnect(newTrack) {
  for (const [, track] of app.tracks) {
    if (track.id === newTrack.id) continue;
    if (canConnect(newTrack.start, track.start)) {
      newTrack.connections.start.push(track.id);
      track.connections.start.push(newTrack.id);
    }
    if (canConnect(newTrack.start, track.end)) {
      newTrack.connections.start.push(track.id);
      track.connections.end.push(newTrack.id);
    }
    if (canConnect(newTrack.end, track.start)) {
      newTrack.connections.end.push(track.id);
      track.connections.start.push(newTrack.id);
    }
    if (canConnect(newTrack.end, track.end)) {
      newTrack.connections.end.push(track.id);
      track.connections.end.push(newTrack.id);
    }
  }
}

function sendOp(type, data) {
  socket.sendOperation(type, data);
}

function pushUndo(action) {
  app._undoStack.push(action);
  if (app._undoStack.length > app._maxUndo) app._undoStack.shift();
}

// ═══════════════════════════════════════════════════════════
//  Rendering Callbacks
// ═══════════════════════════════════════════════════════════

// Draw tracks
renderer.onDraw((ctx, cam) => {
  for (const [id, track] of app.tracks) {
    let state = 'default';
    if (app.selectedElement?.type === 'track' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'track' && app.hoverElement.id === id) state = 'hover';
    track.render(ctx, cam, state);
  }

  // Build preview
  if (app.activeTool === 'straight-track' && app._buildState?.start && app._buildState?.previewEnd) {
    const preview = new Track({
      type: 'straight',
      start: app._buildState.start,
      end: app._buildState.previewEnd,
    });
    preview.renderPreview(ctx, cam);
  }

  if (app.activeTool === 'curved-track' && app._buildState) {
    const bs = app._buildState;
    if (bs.phase === 'end' && bs.previewEnd) {
      const preview = new Track({ type: 'straight', start: bs.start, end: bs.previewEnd });
      preview.renderPreview(ctx, cam);
    } else if (bs.phase === 'control' && bs.previewCP) {
      const midX = (bs.start.x + bs.end.x) / 2;
      const midY = (bs.start.y + bs.end.y) / 2;
      const dx = bs.previewCP.x - midX;
      const dy = bs.previewCP.y - midY;
      const preview = new Track({
        type: 'curve',
        start: bs.start,
        end: bs.end,
        cp1: { x: bs.start.x + dx, y: bs.start.y + dy },
        cp2: { x: bs.end.x + dx, y: bs.end.y + dy },
      });
      preview.renderPreview(ctx, cam);
    }
  }
});

// Draw stations
renderer.onDraw((ctx, cam) => {
  for (const [id, station] of app.stations) {
    let state = 'default';
    if (app.selectedElement?.type === 'station' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'station' && app.hoverElement.id === id) state = 'hover';
    station.render(ctx, cam, state);
  }
});

// Draw signals
renderer.onDraw((ctx, cam) => {
  for (const [id, signal] of app.signals) {
    let state = 'default';
    if (app.selectedElement?.type === 'signal' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'signal' && app.hoverElement.id === id) state = 'hover';
    signal.render(ctx, cam, state);
  }
});

// Draw trains
renderer.onDraw((ctx, cam, dt) => {
  // Update simulation
  simulation.update(dt);

  for (const [id, train] of app.trains) {
    let state = 'default';
    if (app.selectedElement?.type === 'train' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'train' && app.hoverElement.id === id) state = 'hover';
    train.render(ctx, cam, state, simulation.time);
  }
});

// Draw remote cursors
renderer.onDraw((ctx, cam) => {
  for (const [, user] of app.remoteUsers) {
    if (!user.cursor) continue;
    const { x, y } = user.cursor;

    ctx.save();

    // Cursor arrow
    ctx.fillStyle = user.color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 4, y + 14);
    ctx.lineTo(x + 9, y + 9);
    ctx.closePath();
    ctx.fill();

    // Name tag
    const fontSize = 10 / cam.zoom;
    ctx.font = `500 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = user.color;
    const metrics = ctx.measureText(user.name);
    const tagW = metrics.width + 8 / cam.zoom;
    const tagH = fontSize + 4 / cam.zoom;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(x + 12 / cam.zoom, y + 12 / cam.zoom, tagW, tagH, 3 / cam.zoom);
    ctx.fill();

    ctx.fillStyle = user.color;
    ctx.textBaseline = 'top';
    ctx.fillText(user.name, x + 12 / cam.zoom + 4 / cam.zoom, y + 12 / cam.zoom + 2 / cam.zoom);

    ctx.restore();
  }
});

// ═══════════════════════════════════════════════════════════
//  Minimap
// ═══════════════════════════════════════════════════════════
const minimapCanvas = document.getElementById('minimap-canvas');
const minimapCtx = minimapCanvas.getContext('2d');

function renderMinimap() {
  const mw = minimapCanvas.width;
  const mh = minimapCanvas.height;

  minimapCtx.clearRect(0, 0, mw, mh);
  minimapCtx.fillStyle = '#0a0e1a';
  minimapCtx.fillRect(0, 0, mw, mh);

  if (app.tracks.size === 0) {
    requestAnimationFrame(renderMinimap);
    return;
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, track] of app.tracks) {
    for (const p of [track.start, track.end]) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }

  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const worldW = maxX - minX || 1;
  const worldH = maxY - minY || 1;
  const scale = Math.min(mw / worldW, mh / worldH);
  const offX = (mw - worldW * scale) / 2;
  const offY = (mh - worldH * scale) / 2;

  const toMini = (wx, wy) => ({
    x: (wx - minX) * scale + offX,
    y: (wy - minY) * scale + offY,
  });

  // Draw tracks
  minimapCtx.strokeStyle = '#4e6080';
  minimapCtx.lineWidth = 1.5;
  for (const [, track] of app.tracks) {
    const a = toMini(track.start.x, track.start.y);
    const b = toMini(track.end.x, track.end.y);
    minimapCtx.beginPath();
    minimapCtx.moveTo(a.x, a.y);
    minimapCtx.lineTo(b.x, b.y);
    minimapCtx.stroke();
  }

  // Draw stations
  minimapCtx.fillStyle = '#4e8cff';
  for (const [, station] of app.stations) {
    const p = toMini(station.x, station.y);
    minimapCtx.beginPath();
    minimapCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // Draw trains
  for (const [, train] of app.trains) {
    const p = toMini(train.x, train.y);
    minimapCtx.fillStyle = train.color;
    minimapCtx.beginPath();
    minimapCtx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // Viewport rectangle
  const vb = camera.getVisibleBounds();
  const vTL = toMini(vb.minX, vb.minY);
  const vBR = toMini(vb.maxX, vb.maxY);
  minimapCtx.strokeStyle = 'rgba(78, 140, 255, 0.5)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(vTL.x, vTL.y, vBR.x - vTL.x, vBR.y - vTL.y);

  requestAnimationFrame(renderMinimap);
}

renderMinimap();

// ═══════════════════════════════════════════════════════════
//  UI Functions
// ═══════════════════════════════════════════════════════════

function updateToolbarUI() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === app.activeTool);
  });
}

function updatePreviewHint(text) {
  const hint = document.getElementById('track-preview-hint');
  if (text) {
    hint.textContent = text;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    // Default hints per tool
    const defaults = {
      'straight-track': 'Click to place start point',
      'curved-track': 'Click to place start point',
      'station': 'Click near a track to place station',
      'train': 'Click on a track to place train',
      'signal': 'Click near a track to place signal',
      'eraser': 'Click on an element to delete it',
    };
    if (defaults[app.activeTool]) {
      hint.textContent = defaults[app.activeTool];
      hint.classList.remove('hidden');
    }
  }
}

function updateSimButtons() {
  const playBtn = document.getElementById('sim-play-btn');
  const pauseBtn = document.getElementById('sim-pause-btn');

  if (simulation.playing) {
    playBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
  } else {
    playBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
  }
}

function updatePropertiesPanel() {
  const panel = document.getElementById('properties-panel');
  const title = document.getElementById('properties-title');
  const content = document.getElementById('properties-content');

  if (!app.selectedElement) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  const { type, id } = app.selectedElement;

  switch (type) {
    case 'track': {
      const track = app.tracks.get(id);
      if (!track) return;
      title.textContent = 'Track';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Type</span>
          <input class="prop-input" value="${track.type}" readonly />
        </div>
        <div class="prop-field">
          <span class="prop-label">Length</span>
          <input class="prop-input" value="${Math.round(track.getLength())} units" readonly />
        </div>
        <div class="prop-field">
          <span class="prop-label">Speed Limit</span>
          <input class="prop-input" type="number" id="prop-speed-limit" value="${track.speedLimit}" min="10" max="300" />
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-track">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete Track
          </button>
        </div>
      `;
      document.getElementById('prop-speed-limit')?.addEventListener('change', (e) => {
        track.speedLimit = parseInt(e.target.value) || 100;
        sendOp('update-track', track.toJSON());
      });
      document.getElementById('prop-delete-track')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'station': {
      const station = app.stations.get(id);
      if (!station) return;
      title.textContent = 'Station';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Name</span>
          <input class="prop-input" id="prop-station-name" value="${station.name}" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Platforms</span>
          <input class="prop-input" type="number" id="prop-platform-count" value="${station.platformCount}" min="1" max="8" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Color</span>
          <div class="prop-color">
            ${['#4e8cff','#7c5cfc','#22c55e','#eab308','#ef4444','#ec4899','#06b6d4','#f97316'].map(c =>
              `<div class="color-swatch ${station.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}"></div>`
            ).join('')}
          </div>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-station">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-station-name')?.addEventListener('change', (e) => {
        station.name = e.target.value;
        sendOp('update-station', station.toJSON());
      });
      document.getElementById('prop-platform-count')?.addEventListener('change', (e) => {
        station.platformCount = parseInt(e.target.value) || 2;
        sendOp('update-station', station.toJSON());
      });
      content.querySelectorAll('.color-swatch').forEach(sw => {
        sw.addEventListener('click', () => {
          station.color = sw.dataset.color;
          sendOp('update-station', station.toJSON());
          updatePropertiesPanel();
        });
      });
      document.getElementById('prop-delete-station')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'train': {
      const train = app.trains.get(id);
      if (!train) return;
      title.textContent = 'Train';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Name</span>
          <input class="prop-input" id="prop-train-name" value="${train.name}" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Speed</span>
          <input class="prop-input" type="number" id="prop-train-speed" value="${train.speed}" min="10" max="200" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Carriages</span>
          <input class="prop-input" type="number" id="prop-train-carriages" value="${train.carriages}" min="0" max="10" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Color</span>
          <div class="prop-color">
            ${TRAIN_COLORS.map(c =>
              `<div class="color-swatch ${train.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}"></div>`
            ).join('')}
          </div>
        </div>
        <div class="prop-field">
          <span class="prop-label">Route (${train.route.length} segments)</span>
          <button class="btn btn-sm btn-secondary" id="prop-auto-route" style="margin-top:4px">
            <span class="material-icons-round" style="font-size:14px">route</span>Auto-route all connected
          </button>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-train">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-train-name')?.addEventListener('change', (e) => {
        train.name = e.target.value;
        sendOp('update-train', train.toJSON());
      });
      document.getElementById('prop-train-speed')?.addEventListener('change', (e) => {
        train.speed = parseInt(e.target.value) || 60;
        sendOp('update-train', train.toJSON());
      });
      document.getElementById('prop-train-carriages')?.addEventListener('change', (e) => {
        train.carriages = parseInt(e.target.value) || 2;
        sendOp('update-train', train.toJSON());
      });
      content.querySelectorAll('.color-swatch').forEach(sw => {
        sw.addEventListener('click', () => {
          train.color = sw.dataset.color;
          sendOp('update-train', train.toJSON());
          updatePropertiesPanel();
        });
      });
      document.getElementById('prop-auto-route')?.addEventListener('click', () => {
        const connected = pathFinder.getConnectedTracks(train.currentTrackId, app.tracks);
        train.route = connected;
        train.routeIndex = connected.indexOf(train.currentTrackId);
        sendOp('update-train', train.toJSON());
        updatePropertiesPanel();
        app.notify(`Route updated: ${connected.length} segments`, 'success');
      });
      document.getElementById('prop-delete-train')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'signal': {
      const signal = app.signals.get(id);
      if (!signal) return;
      title.textContent = 'Signal';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">State</span>
          <select class="prop-input" id="prop-signal-state">
            <option value="green" ${signal.state === 'green' ? 'selected' : ''}>🟢 Green</option>
            <option value="yellow" ${signal.state === 'yellow' ? 'selected' : ''}>🟡 Yellow</option>
            <option value="red" ${signal.state === 'red' ? 'selected' : ''}>🔴 Red</option>
          </select>
        </div>
        <div class="prop-field">
          <span class="prop-label">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" id="prop-signal-auto" ${signal.autoManage ? 'checked' : ''} />
              Auto-manage (changes with trains)
            </label>
          </span>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-signal">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-signal-state')?.addEventListener('change', (e) => {
        signal.state = e.target.value;
        signal.autoManage = false;
        document.getElementById('prop-signal-auto').checked = false;
        sendOp('update-signal', signal.toJSON());
      });
      document.getElementById('prop-signal-auto')?.addEventListener('change', (e) => {
        signal.autoManage = e.target.checked;
        sendOp('update-signal', signal.toJSON());
      });
      document.getElementById('prop-delete-signal')?.addEventListener('click', () => app.deleteSelected());
      break;
    }
  }
}

function updateUsersUI() {
  const container = document.getElementById('connected-users');
  container.innerHTML = '';

  // Self avatar
  const selfName = document.getElementById('user-name-input')?.value || 'You';
  const selfDiv = document.createElement('div');
  selfDiv.className = 'user-avatar';
  selfDiv.style.background = socket.userColor || '#4e8cff';
  selfDiv.setAttribute('data-name', selfName + ' (You)');
  selfDiv.textContent = selfName.charAt(0).toUpperCase();
  container.appendChild(selfDiv);

  // Remote users
  for (const [, user] of app.remoteUsers) {
    const div = document.createElement('div');
    div.className = 'user-avatar';
    div.style.background = user.color;
    div.setAttribute('data-name', user.name);
    div.textContent = user.name.charAt(0).toUpperCase();
    container.appendChild(div);
  }
}

function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications');
  const iconMap = { info: 'info', success: 'check_circle', warning: 'warning', error: 'error' };
  const notif = document.createElement('div');
  notif.className = `notification ${type}`;
  notif.innerHTML = `<span class="material-icons-round">${iconMap[type] || 'info'}</span> ${message}`;
  container.appendChild(notif);

  setTimeout(() => {
    notif.classList.add('out');
    setTimeout(() => notif.remove(), 300);
  }, 2500);
}

// ═══════════════════════════════════════════════════════════
//  UI Event Bindings
// ═══════════════════════════════════════════════════════════

// Tool buttons
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => app.setTool(btn.dataset.tool));
});

// Simulation controls
document.getElementById('sim-play-btn')?.addEventListener('click', () => app.toggleSimulation());
document.getElementById('sim-pause-btn')?.addEventListener('click', () => app.toggleSimulation());
document.getElementById('sim-stop-btn')?.addEventListener('click', () => {
  simulation.stop();
  socket.sendSimControl({ playing: false });
  updateSimButtons();
});

document.getElementById('sim-speed-slider')?.addEventListener('input', (e) => {
  const speed = parseFloat(e.target.value);
  simulation.setSpeed(speed);
  document.getElementById('sim-speed-value').textContent = `${speed}×`;
  socket.sendSimControl({ speed });
});

// Zoom controls
document.getElementById('zoom-in-btn')?.addEventListener('click', () => {
  camera.zoomAt(canvas.width / 2, canvas.height / 2, 1.2);
  document.getElementById('zoom-level').textContent = camera.getZoomPercent();
});

document.getElementById('zoom-out-btn')?.addEventListener('click', () => {
  camera.zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.2);
  document.getElementById('zoom-level').textContent = camera.getZoomPercent();
});

document.getElementById('zoom-fit-btn')?.addEventListener('click', () => {
  if (app.tracks.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, t] of app.tracks) {
    for (const p of [t.start, t.end]) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  camera.fitBounds(minX, minY, maxX, maxY);
  document.getElementById('zoom-level').textContent = camera.getZoomPercent();
});

// Grid & snap toggles
document.getElementById('toggle-grid-btn')?.addEventListener('click', (e) => {
  grid.visible = !grid.visible;
  e.currentTarget.classList.toggle('active', grid.visible);
});

document.getElementById('toggle-snap-btn')?.addEventListener('click', (e) => {
  grid.snapEnabled = !grid.snapEnabled;
  e.currentTarget.classList.toggle('active', grid.snapEnabled);
});

// Properties close
document.getElementById('close-properties')?.addEventListener('click', () => {
  app.selectedElement = null;
  document.getElementById('properties-panel').classList.add('hidden');
});

// Help modal
document.getElementById('help-btn')?.addEventListener('click', () => {
  document.getElementById('help-modal').classList.remove('hidden');
});
document.getElementById('close-help')?.addEventListener('click', () => {
  document.getElementById('help-modal').classList.add('hidden');
});
document.getElementById('help-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'help-modal') {
    document.getElementById('help-modal').classList.add('hidden');
  }
});

// Copy room code
document.getElementById('copy-room-code')?.addEventListener('click', () => {
  const code = document.getElementById('room-code-display')?.textContent;
  if (code) {
    navigator.clipboard.writeText(code).then(() => {
      showNotification('Room code copied!', 'success');
    });
  }
});

// ═══════════════════════════════════════════════════════════
//  Room Modal & Connection
// ═══════════════════════════════════════════════════════════

async function initRoom(mode, roomCode = '') {
  const modal = document.getElementById('room-modal');
  const errorEl = document.getElementById('modal-error');
  const name = document.getElementById('user-name-input').value || 'User';

  try {
    if (mode === 'solo') {
      modal.classList.add('hidden');
      updateUsersUI();
      showNotification('Welcome to RailForge! Start building your railway.', 'info');
      return;
    }

    await socket.connect();

    if (mode === 'create') {
      const res = await socket.createRoom(name);
      document.getElementById('room-code-display').textContent = res.roomCode;
      document.getElementById('room-info').classList.remove('hidden');
      showNotification(`Room created: ${res.roomCode}`, 'success');
    } else if (mode === 'join') {
      if (!roomCode.trim()) {
        errorEl.textContent = 'Please enter a room code';
        errorEl.classList.remove('hidden');
        return;
      }
      const res = await socket.joinRoom(roomCode, name);
      document.getElementById('room-code-display').textContent = res.roomCode;
      document.getElementById('room-info').classList.remove('hidden');

      // Sync existing state from server
      loadStateFromServer(res.state);
      showNotification(`Joined room ${res.roomCode}`, 'success');
    }

    updateUsersUI();
    modal.classList.add('hidden');

  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function loadStateFromServer(state) {
  // Load tracks
  for (const [id, data] of Object.entries(state.tracks || {})) {
    app.tracks.set(id, new Track(data));
  }
  // Load stations
  for (const [id, data] of Object.entries(state.stations || {})) {
    const s = new Station(data);
    const track = app.tracks.get(s.trackId);
    if (track) s.updateFromTrack(track);
    app.stations.set(id, s);
  }
  // Load trains
  for (const [id, data] of Object.entries(state.trains || {})) {
    const t = new Train(data);
    const track = app.tracks.get(t.currentTrackId);
    if (track) t.updatePosition(track);
    app.trains.set(id, t);
  }
  // Load signals
  for (const [id, data] of Object.entries(state.signals || {})) {
    const sig = new Signal(data);
    const track = app.tracks.get(sig.trackId);
    if (track) sig.updateFromTrack(track);
    app.signals.set(id, sig);
  }
  // Load users
  for (const [uid, userData] of Object.entries(state.users || {})) {
    if (uid !== socket.userId) {
      app.remoteUsers.set(uid, { name: userData.name, color: userData.color, cursor: userData.cursor });
    }
  }
  // Simulation state
  if (state.simulation) {
    if (state.simulation.playing) simulation.play();
    simulation.setSpeed(state.simulation.speed || 1);
    document.getElementById('sim-speed-slider').value = simulation.speed;
    document.getElementById('sim-speed-value').textContent = `${simulation.speed}×`;
    updateSimButtons();
  }
}

// Modal button handlers
document.getElementById('create-room-btn')?.addEventListener('click', () => initRoom('create'));
document.getElementById('join-room-btn')?.addEventListener('click', () => {
  const code = document.getElementById('room-code-input').value;
  initRoom('join', code);
});
document.getElementById('solo-mode-btn')?.addEventListener('click', () => initRoom('solo'));

// Enter key in room code input
document.getElementById('room-code-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const code = e.target.value;
    initRoom('join', code);
  }
});

// ═══════════════════════════════════════════════════════════
//  Initial Setup
// ═══════════════════════════════════════════════════════════
app.setTool('select');
updateUsersUI();

console.log('%c🚂 RailForge Loaded', 'color: #4e8cff; font-size: 16px; font-weight: bold;');
