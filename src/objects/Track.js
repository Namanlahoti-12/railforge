/**
 * Track — data model and rendering for a track segment.
 * Supports straight lines and cubic bezier curves.
 */

const TRACK_COLORS = {
  default: '#8898b8',
  hover: '#7c5cfc',
  selected: '#4e8cff',
  building: 'rgba(78, 140, 255, 0.5)',
};

export class Track {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.type = data.type || 'straight'; // 'straight' | 'curve'
    this.start = data.start || { x: 0, y: 0 };
    this.end = data.end || { x: 0, y: 0 };
    this.cp1 = data.cp1 || null; // control point 1 (for curves)
    this.cp2 = data.cp2 || null; // control point 2 (for curves)
    this.speedLimit = data.speedLimit ?? 100;
    this.color = data.color || TRACK_COLORS.default;
    this.connections = data.connections || { start: [], end: [] }; // track IDs
  }

  /** Serialize to plain object */
  toJSON() {
    return {
      id: this.id, type: this.type,
      start: { ...this.start }, end: { ...this.end },
      cp1: this.cp1 ? { ...this.cp1 } : null,
      cp2: this.cp2 ? { ...this.cp2 } : null,
      speedLimit: this.speedLimit,
      connections: {
        start: [...this.connections.start],
        end: [...this.connections.end],
      },
    };
  }

  /** Get a point along the track at parameter t ∈ [0,1] */
  getPointAt(t) {
    if (this.type === 'straight') {
      return {
        x: this.start.x + t * (this.end.x - this.start.x),
        y: this.start.y + t * (this.end.y - this.start.y),
      };
    }
    // Cubic bezier
    const cp1 = this.cp1 || this._autoCP1();
    const cp2 = this.cp2 || this._autoCP2();
    const u = 1 - t;
    return {
      x: u*u*u*this.start.x + 3*u*u*t*cp1.x + 3*u*t*t*cp2.x + t*t*t*this.end.x,
      y: u*u*u*this.start.y + 3*u*u*t*cp1.y + 3*u*t*t*cp2.y + t*t*t*this.end.y,
    };
  }

  /** Get tangent direction at parameter t (normalized) */
  getTangentAt(t) {
    const dt = 0.001;
    const p1 = this.getPointAt(Math.max(0, t - dt));
    const p2 = this.getPointAt(Math.min(1, t + dt));
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx*dx + dy*dy) || 1;
    return { x: dx/len, y: dy/len };
  }

  /** Get normal (perpendicular to tangent) at parameter t */
  getNormalAt(t) {
    const tan = this.getTangentAt(t);
    return { x: -tan.y, y: tan.x };
  }

  /** Approximate length by sampling */
  getLength() {
    const steps = 40;
    let length = 0;
    let prev = this.getPointAt(0);
    for (let i = 1; i <= steps; i++) {
      const p = this.getPointAt(i / steps);
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      length += Math.sqrt(dx*dx + dy*dy);
      prev = p;
    }
    return length;
  }

  /** Hit-test: is a world point within `threshold` pixels of this track? */
  hitTest(wx, wy, threshold = 10) {
    const steps = 30;
    for (let i = 0; i <= steps; i++) {
      const p = this.getPointAt(i / steps);
      const dx = wx - p.x;
      const dy = wy - p.y;
      if (dx*dx + dy*dy < threshold * threshold) return true;
    }
    return false;
  }

  /** Find closest parameter t to a world point */
  closestT(wx, wy) {
    const steps = 60;
    let bestT = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = this.getPointAt(t);
      const d = (wx - p.x)**2 + (wy - p.y)**2;
      if (d < bestDist) {
        bestDist = d;
        bestT = t;
      }
    }
    return bestT;
  }

  /** Auto control point 1 */
  _autoCP1() {
    const dx = this.end.x - this.start.x;
    const dy = this.end.y - this.start.y;
    return { x: this.start.x + dx * 0.33, y: this.start.y + dy * 0.33 };
  }

  /** Auto control point 2 */
  _autoCP2() {
    const dx = this.end.x - this.start.x;
    const dy = this.end.y - this.start.y;
    return { x: this.start.x + dx * 0.67, y: this.start.y + dy * 0.67 };
  }

  /** Render this track on a canvas context */
  render(ctx, camera, state = 'default') {
    const zoom = camera.zoom;
    const railGauge = 6;       // half-distance between rails
    const sleeperLen = 14;
    const sleeperSpacing = 16;

    const color = state === 'hover' ? TRACK_COLORS.hover
                : state === 'selected' ? TRACK_COLORS.selected
                : state === 'building' ? TRACK_COLORS.building
                : TRACK_COLORS.default;

    // Draw sleepers first
    const length = this.getLength();
    const numSleepers = Math.max(2, Math.floor(length / sleeperSpacing));

    ctx.save();
    ctx.strokeStyle = '#3a4560';
    ctx.lineWidth = Math.max(2, 3 / Math.sqrt(zoom));
    ctx.lineCap = 'round';

    for (let i = 0; i <= numSleepers; i++) {
      const t = i / numSleepers;
      const p = this.getPointAt(t);
      const n = this.getNormalAt(t);
      const half = sleeperLen / 2;
      ctx.beginPath();
      ctx.moveTo(p.x - n.x * half, p.y - n.y * half);
      ctx.lineTo(p.x + n.x * half, p.y + n.y * half);
      ctx.stroke();
    }

    // Draw two rails
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 2 / Math.sqrt(zoom));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const sign of [-1, 1]) {
      ctx.beginPath();
      const steps = 50;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = this.getPointAt(t);
        const n = this.getNormalAt(t);
        const x = p.x + n.x * railGauge * sign / 2;
        const y = p.y + n.y * railGauge * sign / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Glow effect for selected/hover
    if (state === 'selected' || state === 'hover') {
      ctx.strokeStyle = state === 'selected'
        ? 'rgba(78, 140, 255, 0.2)'
        : 'rgba(124, 92, 252, 0.15)';
      ctx.lineWidth = 12 / Math.sqrt(zoom);
      ctx.beginPath();
      if (this.type === 'straight') {
        ctx.moveTo(this.start.x, this.start.y);
        ctx.lineTo(this.end.x, this.end.y);
      } else {
        const cp1 = this.cp1 || this._autoCP1();
        const cp2 = this.cp2 || this._autoCP2();
        ctx.moveTo(this.start.x, this.start.y);
        ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, this.end.x, this.end.y);
      }
      ctx.stroke();
    }

    // Endpoint dots
    const dotR = Math.max(3, 4 / Math.sqrt(zoom));
    for (const p of [this.start, this.end]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
      ctx.fill();

      // Outer ring
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Render a preview/ghost while building */
  renderPreview(ctx, camera) {
    this.render(ctx, camera, 'building');
  }
}

/** Utility: distance between two points */
export function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

/** Utility: check if two endpoints are close enough to connect */
export function canConnect(p1, p2, threshold = 20) {
  return dist(p1, p2) < threshold;
}
