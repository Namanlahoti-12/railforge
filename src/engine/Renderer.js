/**
 * Renderer — main canvas rendering engine.
 * Orchestrates drawing of all layers via requestAnimationFrame.
 */
export class Renderer {
  constructor(canvas, camera, grid) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.grid = grid;

    this.running = true;
    this.drawCallbacks = [];  // functions called each frame
    this.logicalWidth = 0;
    this.logicalHeight = 0;

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._loop();
  }

  /** Register a draw callback: fn(ctx, camera, dt) */
  onDraw(fn) {
    this.drawCallbacks.push(fn);
  }

  _resize() {
    const container = this.canvas.parentElement;
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.logicalWidth = w;
    this.logicalHeight = h;

    // Set actual pixel dimensions
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // Scale context for DPR
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Update camera's reference dimensions
    this.camera._logicalWidth = w;
    this.camera._logicalHeight = h;
  }

  _lastTime = 0;

  _loop = (time = 0) => {
    if (!this.running) return;

    const dt = Math.min((time - this._lastTime) / 1000, 0.1); // cap delta
    this._lastTime = time;

    const ctx = this.ctx;
    const w = this.logicalWidth;
    const h = this.logicalHeight;

    // Clear
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    // Background
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, w, h);

    // Apply camera transform
    this.camera.applyTransform(ctx);

    // Draw grid
    this.grid.render(ctx, this.camera);

    // Draw registered layers
    for (const cb of this.drawCallbacks) {
      ctx.save();
      cb(ctx, this.camera, dt);
      ctx.restore();
    }

    // Reset transform for HUD overlays
    this.camera.resetTransform(ctx);

    requestAnimationFrame(this._loop);
  };

  destroy() {
    this.running = false;
  }
}
