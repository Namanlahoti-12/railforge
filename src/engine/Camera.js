/**
 * Camera — handles pan/zoom and coordinate transforms.
 */
export class Camera {
  constructor(canvas) {
    this.canvas = canvas;
    this.x = 0;       // world-space offset
    this.y = 0;
    this.zoom = 1;
    this.minZoom = 0.1;
    this.maxZoom = 5;

    // Logical (CSS) dimensions — set by Renderer on resize
    this._logicalWidth = canvas.clientWidth || 800;
    this._logicalHeight = canvas.clientHeight || 600;
  }

  /** Logical width (CSS pixels, not device pixels) */
  get width() { return this._logicalWidth; }
  get height() { return this._logicalHeight; }

  /** Convert screen coords → world coords */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  /** Convert world coords → screen coords */
  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: (wy - this.y) * this.zoom + this.height / 2,
    };
  }

  /** Pan by delta in screen pixels */
  pan(dx, dy) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Zoom towards a screen point */
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Zoom to fit a bounding box (with padding) */
  fitBounds(minX, minY, maxX, maxY, padding = 80) {
    const w = maxX - minX;
    const h = maxY - minY;
    if (w === 0 && h === 0) return;

    const scaleX = (this.width - padding * 2) / (w || 1);
    const scaleY = (this.height - padding * 2) / (h || 1);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(scaleX, scaleY)));
    this.x = minX + w / 2;
    this.y = minY + h / 2;
  }

  /** Apply camera transform to a canvas context */
  applyTransform(ctx) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  /** Reset transform */
  resetTransform(ctx) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Get visible world bounds */
  getVisibleBounds() {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.width, this.height);
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
  }

  /** Get zoom as a percentage string */
  getZoomPercent() {
    return `${Math.round(this.zoom * 100)}%`;
  }
}

