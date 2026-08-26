/**
 * Grid — renders an infinite background grid with snap logic.
 */
export class Grid {
  constructor() {
    this.size = 30;        // base grid spacing in world units
    this.visible = true;
    this.snapEnabled = true;
    this.majorEvery = 5;   // every 5th line is major
  }

  /** Snap a world point to the nearest grid intersection */
  snap(x, y) {
    if (!this.snapEnabled) return { x, y };
    return {
      x: Math.round(x / this.size) * this.size,
      y: Math.round(y / this.size) * this.size,
    };
  }

  /** Render the grid onto a canvas context (camera already applied) */
  render(ctx, camera) {
    if (!this.visible) return;

    const bounds = camera.getVisibleBounds();
    const startX = Math.floor(bounds.minX / this.size) * this.size;
    const startY = Math.floor(bounds.minY / this.size) * this.size;
    const endX = Math.ceil(bounds.maxX / this.size) * this.size;
    const endY = Math.ceil(bounds.maxY / this.size) * this.size;

    // Adjust opacity based on zoom
    const baseAlpha = Math.min(0.25, 0.08 + camera.zoom * 0.06);

    ctx.save();

    // Minor grid lines
    ctx.strokeStyle = `rgba(100, 140, 255, ${baseAlpha * 0.4})`;
    ctx.lineWidth = 0.5 / camera.zoom;
    ctx.beginPath();

    for (let x = startX; x <= endX; x += this.size) {
      const idx = Math.round(x / this.size);
      if (idx % this.majorEvery === 0) continue;
      ctx.moveTo(x, bounds.minY);
      ctx.lineTo(x, bounds.maxY);
    }
    for (let y = startY; y <= endY; y += this.size) {
      const idx = Math.round(y / this.size);
      if (idx % this.majorEvery === 0) continue;
      ctx.moveTo(bounds.minX, y);
      ctx.lineTo(bounds.maxX, y);
    }
    ctx.stroke();

    // Major grid lines
    ctx.strokeStyle = `rgba(100, 140, 255, ${baseAlpha})`;
    ctx.lineWidth = 1 / camera.zoom;
    ctx.beginPath();

    const majorSize = this.size * this.majorEvery;
    const mStartX = Math.floor(bounds.minX / majorSize) * majorSize;
    const mStartY = Math.floor(bounds.minY / majorSize) * majorSize;
    const mEndX = Math.ceil(bounds.maxX / majorSize) * majorSize;
    const mEndY = Math.ceil(bounds.maxY / majorSize) * majorSize;

    for (let x = mStartX; x <= mEndX; x += majorSize) {
      ctx.moveTo(x, bounds.minY);
      ctx.lineTo(x, bounds.maxY);
    }
    for (let y = mStartY; y <= mEndY; y += majorSize) {
      ctx.moveTo(bounds.minX, y);
      ctx.lineTo(bounds.maxX, y);
    }
    ctx.stroke();

    // Origin axes
    ctx.strokeStyle = `rgba(100, 140, 255, ${baseAlpha * 1.5})`;
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.beginPath();
    ctx.moveTo(0, bounds.minY);
    ctx.lineTo(0, bounds.maxY);
    ctx.moveTo(bounds.minX, 0);
    ctx.lineTo(bounds.maxX, 0);
    ctx.stroke();

    ctx.restore();
  }
}
