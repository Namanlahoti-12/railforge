/**
 * InputHandler — mouse/keyboard events → tool actions.
 * Delegates to the active tool's handler methods.
 */
export class InputHandler {
  constructor(canvas, camera, grid, appState) {
    this.canvas = canvas;
    this.camera = camera;
    this.grid = grid;
    this.app = appState;

    this._isPanning = false;
    this._panStart = { x: 0, y: 0 };
    this._lastMouse = { x: 0, y: 0 };
    this._mouseWorld = { x: 0, y: 0 };
    this._cursorThrottle = 0;

    this._bindEvents();
  }

  getMouseWorld() {
    return { ...this._mouseWorld };
  }

  _getCanvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => this._onMouseDown(e));
    c.addEventListener('mousemove', (e) => this._onMouseMove(e));
    c.addEventListener('mouseup', (e) => this._onMouseUp(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', (e) => this._onDoubleClick(e));

    // Touch events for mobile
    c.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this._onTouchEnd(e));

    // Keyboard
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
  }

  // ─── Mouse Events ─────────────────────────────────────

  _onMouseDown(e) {
    const pos = this._getCanvasPos(e);
    const world = this.camera.screenToWorld(pos.x, pos.y);

    // Middle click or space+click = pan
    if (e.button === 1 || (e.button === 0 && this.app.activeTool === 'pan')) {
      this._isPanning = true;
      this._panStart = pos;
      const container = this.canvas.parentElement;
      container.classList.add('panning');
      return;
    }

    // Right click = cancel current operation
    if (e.button === 2) {
      this.app.cancelCurrentAction?.();
      return;
    }

    // Left click
    if (e.button === 0) {
      const snapped = this.grid.snap(world.x, world.y);
      this.app.handleToolClick?.(snapped, world, e);
    }
  }

  _onMouseMove(e) {
    const pos = this._getCanvasPos(e);
    const world = this.camera.screenToWorld(pos.x, pos.y);
    this._mouseWorld = world;

    // Update cursor position display
    const coordsEl = document.getElementById('cursor-coords');
    if (coordsEl) {
      coordsEl.textContent = `X: ${Math.round(world.x)}  Y: ${Math.round(world.y)}`;
    }

    // Panning
    if (this._isPanning) {
      const dx = pos.x - this._panStart.x;
      const dy = pos.y - this._panStart.y;
      this.camera.pan(dx, dy);
      this._panStart = pos;
      return;
    }

    // Tool hover/preview
    const snapped = this.grid.snap(world.x, world.y);
    this.app.handleToolMove?.(snapped, world, e);

    // Broadcast cursor to collaborators (throttled)
    const now = Date.now();
    if (now - this._cursorThrottle > 50) {
      this._cursorThrottle = now;
      this.app.broadcastCursor?.(world);
    }

    this._lastMouse = pos;
  }

  _onMouseUp(e) {
    if (this._isPanning) {
      this._isPanning = false;
      const container = this.canvas.parentElement;
      container.classList.remove('panning');
    }

    if (e.button === 0) {
      const pos = this._getCanvasPos(e);
      const world = this.camera.screenToWorld(pos.x, pos.y);
      const snapped = this.grid.snap(world.x, world.y);
      this.app.handleToolRelease?.(snapped, world, e);
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const pos = this._getCanvasPos(e);
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    this.camera.zoomAt(pos.x, pos.y, factor);

    // Update zoom display
    const zoomEl = document.getElementById('zoom-level');
    if (zoomEl) zoomEl.textContent = this.camera.getZoomPercent();
  }

  _onDoubleClick(e) {
    const pos = this._getCanvasPos(e);
    const world = this.camera.screenToWorld(pos.x, pos.y);
    this.app.handleToolDoubleClick?.(world, e);
  }

  // ─── Touch Events ─────────────────────────────────────

  _touchDist = 0;

  _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      this._touchDist = Math.sqrt(dx * dx + dy * dy);
      this._isPanning = true;
      this._panStart = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1) {
      const rect = this.canvas.getBoundingClientRect();
      const pos = {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
      const world = this.camera.screenToWorld(pos.x, pos.y);
      const snapped = this.grid.snap(world.x, world.y);
      this.app.handleToolClick?.(snapped, world, e);
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      // Pinch zoom
      if (this._touchDist > 0) {
        const factor = dist / this._touchDist;
        const rect = this.canvas.getBoundingClientRect();
        this.camera.zoomAt(midX - rect.left, midY - rect.top, factor);
      }
      this._touchDist = dist;

      // Pan
      if (this._isPanning) {
        const pdx = midX - this._panStart.x;
        const pdy = midY - this._panStart.y;
        this.camera.pan(pdx, pdy);
        this._panStart = { x: midX, y: midY };
      }
    } else if (e.touches.length === 1) {
      const rect = this.canvas.getBoundingClientRect();
      const pos = {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
      const world = this.camera.screenToWorld(pos.x, pos.y);
      const snapped = this.grid.snap(world.x, world.y);
      this.app.handleToolMove?.(snapped, world, e);
    }
  }

  _onTouchEnd(e) {
    this._isPanning = false;
    this._touchDist = 0;
  }

  // ─── Keyboard Events ──────────────────────────────────

  _onKeyDown(e) {
    // Don't intercept if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Tool shortcuts
    const toolMap = {
      'v': 'select',
      'h': 'pan',
      't': 'straight-track',
      'c': 'curved-track',
      's': 'station',
      'r': 'train',
      'g': 'signal',
      'e': 'eraser',
    };

    const key = e.key.toLowerCase();

    if (toolMap[key] && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.app.setTool?.(toolMap[key]);
      return;
    }

    if (key === ' ') {
      e.preventDefault();
      this.app.toggleSimulation?.();
      return;
    }

    if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      this.app.deleteSelected?.();
      return;
    }

    if (key === 'escape') {
      this.app.cancelCurrentAction?.();
      return;
    }

    if (key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.app.undo?.();
      return;
    }

    // Ctrl+G = toggle grid
    if (key === 'g' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.grid.visible = !this.grid.visible;
      const btn = document.getElementById('toggle-grid-btn');
      btn?.classList.toggle('active', this.grid.visible);
      return;
    }

    // +/- zoom
    if (key === '=' || key === '+') {
      this.camera.zoomAt(this.camera.width / 2, this.camera.height / 2, 1.15);
    }
    if (key === '-') {
      this.camera.zoomAt(this.camera.width / 2, this.camera.height / 2, 1 / 1.15);
    }
  }

  _onKeyUp(e) {
    // nothing needed for now
  }
}
