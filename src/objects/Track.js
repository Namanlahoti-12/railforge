/**
 * Track — data model and rendering for a track segment.
 * Supports straight lines, cubic bezier curves, and track classifications.
 * v2: Added drag handles, track classes (mainline/siding/junction/crossover).
 */

const TRACK_COLORS = {
  default: '#8898b8',
  hover: '#7c5cfc',
  selected: '#4e8cff',
  building: 'rgba(78, 140, 255, 0.5)',
  siding: '#5a6a80',
  crossover: '#b87333',
};

const HANDLE_RADIUS = 6;
const HANDLE_COLORS = {
  endpoint: '#4e8cff',
  controlPoint: '#eab308',
  hover: '#ffffff',
};

export class Track {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.type = data.type || 'straight'; // 'straight' | 'curve'
    this.trackClass = data.trackClass || 'mainline'; // 'mainline' | 'siding' | 'crossover'
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
      id: this.id, type: this.type, trackClass: this.trackClass,
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

  /** Hit-test a drag handle. Returns handle name or null. */
  hitTestHandle(wx, wy, zoom = 1) {
    const r = (HANDLE_RADIUS + 4) / zoom;
    const rSq = r * r;

    const dStart = (wx - this.start.x)**2 + (wy - this.start.y)**2;
    if (dStart < rSq) return 'start';

    const dEnd = (wx - this.end.x)**2 + (wy - this.end.y)**2;
    if (dEnd < rSq) return 'end';

    if (this.type === 'curve') {
      const cp1 = this.cp1 || this._autoCP1();
      const cp2 = this.cp2 || this._autoCP2();
      const dCP1 = (wx - cp1.x)**2 + (wy - cp1.y)**2;
      if (dCP1 < rSq) return 'cp1';
      const dCP2 = (wx - cp2.x)**2 + (wy - cp2.y)**2;
      if (dCP2 < rSq) return 'cp2';
    }

    return null;
  }

  /** Move a handle to a new position */
  moveHandle(handleName, x, y) {
    switch (handleName) {
      case 'start': this.start = { x, y }; break;
      case 'end': this.end = { x, y }; break;
      case 'cp1': this.cp1 = { x, y }; break;
      case 'cp2': this.cp2 = { x, y }; break;
    }
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
    const railGauge = 6;
    const sleeperLen = this.trackClass === 'siding' ? 10 : 14;
    const sleeperSpacing = this.trackClass === 'siding' ? 20 : 16;

    const isSiding = this.trackClass === 'siding';
    const isCrossover = this.trackClass === 'crossover';

    let color = state === 'hover' ? TRACK_COLORS.hover
              : state === 'selected' ? TRACK_COLORS.selected
              : state === 'building' ? TRACK_COLORS.building
              : isSiding ? TRACK_COLORS.siding
              : isCrossover ? TRACK_COLORS.crossover
              : TRACK_COLORS.default;

    // Draw sleepers first
    const length = this.getLength();
    const numSleepers = Math.max(2, Math.floor(length / sleeperSpacing));

    ctx.save();
    ctx.strokeStyle = isSiding ? '#2a3450' : '#3a4560';
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

    // Siding uses dashed lines
    if (isSiding) {
      ctx.setLineDash([6 / zoom, 4 / zoom]);
    }

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

    ctx.setLineDash([]);

    // Crossover X marks at quarter points
    if (isCrossover) {
      ctx.strokeStyle = TRACK_COLORS.crossover;
      ctx.lineWidth = 2 / Math.sqrt(zoom);
      for (const t of [0.25, 0.5, 0.75]) {
        const p = this.getPointAt(t);
        const n = this.getNormalAt(t);
        const sz = 5;
        ctx.beginPath();
        ctx.moveTo(p.x - sz, p.y - sz);
        ctx.lineTo(p.x + sz, p.y + sz);
        ctx.moveTo(p.x + sz, p.y - sz);
        ctx.lineTo(p.x - sz, p.y + sz);
        ctx.stroke();
      }
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

    // Track class label for siding
    if (isSiding && zoom > 0.6) {
      const mid = this.getPointAt(0.5);
      const fontSize = Math.max(7, 9 / Math.sqrt(zoom));
      ctx.font = `500 ${fontSize}px Inter, sans-serif`;
      ctx.fillStyle = 'rgba(90, 106, 128, 0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('SIDING', mid.x, mid.y - 10);
    }

    ctx.restore();
  }

  /** Render interactive drag handles (only when selected) */
  renderHandles(ctx, camera, hoveredHandle = null) {
    const zoom = camera.zoom;
    const r = HANDLE_RADIUS / Math.sqrt(zoom);

    const handles = [
      { name: 'start', ...this.start, color: HANDLE_COLORS.endpoint },
      { name: 'end', ...this.end, color: HANDLE_COLORS.endpoint },
    ];

    if (this.type === 'curve') {
      const cp1 = this.cp1 || this._autoCP1();
      const cp2 = this.cp2 || this._autoCP2();
      handles.push(
        { name: 'cp1', x: cp1.x, y: cp1.y, color: HANDLE_COLORS.controlPoint },
        { name: 'cp2', x: cp2.x, y: cp2.y, color: HANDLE_COLORS.controlPoint },
      );

      // Draw dashed lines from endpoints to control points
      ctx.save();
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.3)';
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      ctx.beginPath();
      ctx.moveTo(this.start.x, this.start.y);
      ctx.lineTo(cp1.x, cp1.y);
      ctx.moveTo(this.end.x, this.end.y);
      ctx.lineTo(cp2.x, cp2.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    for (const h of handles) {
      const isHovered = hoveredHandle === h.name;
      const radius = isHovered ? r * 1.3 : r;

      // Outer glow
      ctx.fillStyle = isHovered ? 'rgba(255,255,255,0.15)' : 'rgba(78,140,255,0.08)';
      ctx.beginPath();
      ctx.arc(h.x, h.y, radius + 4 / zoom, 0, Math.PI * 2);
      ctx.fill();

      // Handle circle
      ctx.fillStyle = isHovered ? HANDLE_COLORS.hover : h.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2);
      ctx.fill();
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
