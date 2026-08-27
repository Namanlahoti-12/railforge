/**
 * PathFinder v7 — Directional RouteStep output.
 *
 * v7 over v6:
 *   buildStationRoute() now returns RouteStep[] instead of string[].
 *
 *   A RouteStep is:
 *     { trackId, fromNode, toNode, fromT, toT, direction }
 *
 *   fromT / toT are derived from _nodeTbyTrack (a precise map built
 *   during graph construction using exact station.trackT values and the
 *   canonical 0/1 for track endpoints) — no lossy closestT() sampling.
 *
 *   Consecutive same-track, same-direction, contiguous steps are merged
 *   into one step (collapses station-split sub-edges for same-direction
 *   traversal). Steps with different directions (backtracking through a
 *   dead-end branch) are deliberately NOT merged.
 *
 *   All Union-Find connectivity, error reporting, and graph construction
 *   from v6 are fully preserved.
 *
 * Pipeline:
 *   PathFinder.buildStationRoute()
 *       ↓  RouteStep[]
 *   main.js route-save handler
 *       ↓  train.route = RouteStep[]
 *   Train.advance()
 *       ↓  follows step.fromT → step.toT with step.direction
 *   Junction / Signal / Collision (unchanged — still use currentTrackId + t)
 */
export class PathFinder {
  constructor() {
    this._adj          = new Map(); // nodeId → [{trackId, toNode, weight}]
    this._nodeCoords   = new Map(); // nodeId → {x, y}
    this._nodeCounter  = 0;
    this._trackNodes   = new Map(); // trackId → {s: nodeId, e: nodeId}
    this._nodeTbyTrack = new Map(); // "${nodeId}:${trackId}" → t ∈ [0,1]
  }

  // ─────────────────────────────────────────────────────────
  //  Internal graph helpers
  // ─────────────────────────────────────────────────────────

  _addEdge(from, to, trackId, weight) {
    this._adj.get(from).push({ toNode: to, trackId, weight });
    this._adj.get(to).push({ toNode: from, trackId, weight });
  }

  _removeEdge(from, to, trackId) {
    const rm = (list, target, tid) => {
      const i = list?.findIndex(e => e.toNode === target && e.trackId === tid);
      if (i >= 0) list.splice(i, 1);
    };
    rm(this._adj.get(from), to, trackId);
    rm(this._adj.get(to), from, trackId);
  }

  _newNode(coords) {
    const id = this._nodeCounter++;
    this._adj.set(id, []);
    this._nodeCoords.set(id, { x: coords.x, y: coords.y });
    return id;
  }

  // ─────────────────────────────────────────────────────────
  //  Build graph from tracks + inject station virtual nodes
  // ─────────────────────────────────────────────────────────

  /**
   * Build the routing graph using Union-Find to merge connected endpoints.
   * Populates _nodeTbyTrack so buildStationRoute() can derive exact t values.
   *
   * @param {Map} tracks
   * @param {Map} [stations]
   * @returns {Map} stationNodeMap: stationId → nodeId
   */
  buildGraph(tracks, stations = new Map()) {
    this._adj.clear();
    this._nodeCoords.clear();
    this._nodeCounter = 0;
    this._trackNodes.clear();
    this._nodeTbyTrack.clear();

    const trackArr = [...tracks.values()];
    const N        = trackArr.length;
    if (N === 0) return new Map();

    // ── Step 1: Union-Find over raw endpoint indices (0..2N-1) ──
    // Index layout: track i → start = 2i, end = 2i+1
    const parent = Array.from({ length: N * 2 }, (_, i) => i);

    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (x, y) => {
      const rx = find(x), ry = find(y);
      if (rx !== ry) parent[rx] = ry;
    };

    const trackToIdx = new Map();
    for (let i = 0; i < N; i++) trackToIdx.set(trackArr[i].id, i);

    const THRESHOLD = 20;

    for (let i = 0; i < N; i++) {
      const track = trackArr[i];

      // ── Primary: track.connections[] (set by autoConnect) ──
      for (const connId of (track.connections?.start || [])) {
        const ci = trackToIdx.get(connId);
        if (ci === undefined) continue;
        const conn = trackArr[ci];
        const dS = Math.hypot(track.start.x - conn.start.x, track.start.y - conn.start.y);
        const dE = Math.hypot(track.start.x - conn.end.x,   track.start.y - conn.end.y);
        union(2 * i, dS <= dE ? 2 * ci : 2 * ci + 1);
      }
      for (const connId of (track.connections?.end || [])) {
        const ci = trackToIdx.get(connId);
        if (ci === undefined) continue;
        const conn = trackArr[ci];
        const dS = Math.hypot(track.end.x - conn.start.x, track.end.y - conn.start.y);
        const dE = Math.hypot(track.end.x - conn.end.x,   track.end.y - conn.end.y);
        union(2 * i + 1, dS <= dE ? 2 * ci : 2 * ci + 1);
      }

      // ── Fallback: proximity merge for tracks with no connections data ──
      for (let j = i + 1; j < N; j++) {
        const other = trackArr[j];
        if (Math.hypot(track.start.x - other.start.x, track.start.y - other.start.y) < THRESHOLD) union(2*i,   2*j);
        if (Math.hypot(track.start.x - other.end.x,   track.start.y - other.end.y)   < THRESHOLD) union(2*i,   2*j+1);
        if (Math.hypot(track.end.x   - other.start.x, track.end.y   - other.start.y) < THRESHOLD) union(2*i+1, 2*j);
        if (Math.hypot(track.end.x   - other.end.x,   track.end.y   - other.end.y)   < THRESHOLD) union(2*i+1, 2*j+1);
      }
    }

    // ── Step 2: Materialise canonical graph nodes from UF roots ──
    const rootToNodeId = new Map();

    const canonOf = (ufIdx) => {
      const root = find(ufIdx);
      if (!rootToNodeId.has(root)) {
        const ti     = Math.floor(root / 2);
        const coords = root % 2 === 0 ? trackArr[ti].start : trackArr[ti].end;
        rootToNodeId.set(root, this._newNode(coords));
      }
      return rootToNodeId.get(root);
    };

    for (let i = 0; i < N; i++) {
      this._trackNodes.set(trackArr[i].id, {
        s: canonOf(2 * i),
        e: canonOf(2 * i + 1),
      });
    }

    // ── Step 3: Add graph edges + record t=0/1 for endpoint nodes ──
    for (let i = 0; i < N; i++) {
      const track    = trackArr[i];
      const { s, e } = this._trackNodes.get(track.id);
      const len      = track.getLength() || 1;

      if (s !== e) this._addEdge(s, e, track.id, len);

      // Record exact t values for endpoint nodes on this track.
      // Key = "${nodeId}:${trackId}" so junction nodes can store different
      // t values for different tracks (t=1 on T1, t=0 on T2, etc.).
      this._nodeTbyTrack.set(`${s}:${track.id}`, 0);
      this._nodeTbyTrack.set(`${e}:${track.id}`, 1);
    }

    // ── Step 4: Inject station virtual nodes ──
    const stationsByTrack = new Map();
    for (const [sid, station] of stations) {
      if (!station.trackId) continue;
      if (!stationsByTrack.has(station.trackId)) stationsByTrack.set(station.trackId, []);
      stationsByTrack.get(station.trackId).push({ stationId: sid, t: station.trackT });
    }

    const stationNodeMap = new Map();

    for (let i = 0; i < N; i++) {
      const track     = trackArr[i];
      const tStations = stationsByTrack.get(track.id) || [];
      if (tStations.length === 0) continue;

      const { s: sn, e: en } = this._trackNodes.get(track.id);
      const totalLen = track.getLength() || 1;

      const injectPts = [
        { t: 0, nodeId: sn },
        { t: 1, nodeId: en },
      ];

      for (const s of tStations) {
        const pt    = track.getPointAt(s.t);
        const vNode = this._newNode(pt);
        injectPts.push({ t: s.t, nodeId: vNode });
        stationNodeMap.set(s.stationId, vNode);

        // Record exact t for this station's virtual node
        this._nodeTbyTrack.set(`${vNode}:${track.id}`, s.t);
      }

      injectPts.sort((a, b) => a.t - b.t);
      this._removeEdge(sn, en, track.id);

      for (let k = 0; k < injectPts.length - 1; k++) {
        const a = injectPts[k];
        const b = injectPts[k + 1];
        const w = (b.t - a.t) * totalLen;
        if (a.nodeId !== b.nodeId && w > 0) {
          this._addEdge(a.nodeId, b.nodeId, track.id, w);
        }
      }
    }

    return stationNodeMap;
  }

  // ─────────────────────────────────────────────────────────
  //  Dijkstra
  // ─────────────────────────────────────────────────────────

  _dijkstra(sourceNode, targetNode) {
    const dist    = new Map();
    const prev    = new Map();
    const visited = new Set();

    for (const [n] of this._adj) dist.set(n, Infinity);
    dist.set(sourceNode, 0);

    const pq = [[0, sourceNode]];

    while (pq.length > 0) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();

      if (visited.has(u)) continue;
      visited.add(u);
      if (u === targetNode) break;

      for (const edge of (this._adj.get(u) || [])) {
        const alt = d + edge.weight;
        if (alt < (dist.get(edge.toNode) ?? Infinity)) {
          dist.set(edge.toNode, alt);
          prev.set(edge.toNode, { fromNode: u, trackId: edge.trackId });
          pq.push([alt, edge.toNode]);
        }
      }
    }

    if (!prev.has(targetNode)) return null;

    const edges = [];
    let cur = targetNode;
    while (prev.has(cur)) {
      const { fromNode, trackId } = prev.get(cur);
      if (trackId !== null) edges.unshift({ trackId, fromNode, toNode: cur });
      cur = fromNode;
    }
    return edges;
  }

  // ─────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────

  /**
   * Build the full ordered route as a RouteStep[] for a multi-stop sequence.
   *
   * Each RouteStep: { trackId, fromNode, toNode, fromT, toT, direction }
   *
   * fromT/toT come from _nodeTbyTrack (exact values, not approximations).
   * direction = +1 if fromT < toT, -1 if fromT > toT.
   *
   * Consecutive steps with same trackId + same direction + contiguous t values
   * are merged into one step (handles station-split sub-edges). Steps with
   * different directions are never merged (handles dead-end branch backtracking).
   *
   * @param {Array} stationStops  [{stationId, stationName}, ...]
   * @param {Map}   stations
   * @param {Map}   tracks
   * @returns {{ route: RouteStep[], segmentMap: Map, errors: string[] }}
   */
  buildStationRoute(stationStops, stations, tracks) {
    if (stationStops.length < 1) return { route: [], segmentMap: new Map(), errors: [] };

    const stationNodeMap = this.buildGraph(tracks, stations);

    const rawSteps  = [];
    const segmentMap = new Map();
    const errors     = [];

    for (let i = 0; i < stationStops.length - 1; i++) {
      const from = stationStops[i];
      const to   = stationStops[i + 1];

      const fromNode = stationNodeMap.get(from.stationId);
      const toNode   = stationNodeMap.get(to.stationId);

      if (fromNode === undefined) {
        errors.push(`⚠ "${from.stationName}" is not placed on any track`);
        continue;
      }
      if (toNode === undefined) {
        errors.push(`⚠ "${to.stationName}" is not placed on any track`);
        continue;
      }

      if (i === 0) segmentMap.set(from.stationId, 0);

      const edges = this._dijkstra(fromNode, toNode);

      if (!edges || edges.length === 0) {
        errors.push(
          `❌ No track path from "${from.stationName}" → "${to.stationName}". ` +
          `Lay connected track between them and try again.`
        );
        continue;
      }

      for (const edge of edges) {
        if (!edge.trackId) continue;

        // Retrieve exact t values from _nodeTbyTrack (built during graph construction).
        // These are exact: 0 or 1 for track endpoints, station.trackT for station nodes.
        const fromT = this._nodeTbyTrack.get(`${edge.fromNode}:${edge.trackId}`) ?? 0;
        const toT   = this._nodeTbyTrack.get(`${edge.toNode}:${edge.trackId}`)   ?? 1;

        // Skip zero-length steps (e.g. station placed exactly at a track endpoint)
        if (Math.abs(toT - fromT) < 0.0001) continue;

        const direction = toT > fromT ? 1 : -1;

        rawSteps.push({
          trackId:   edge.trackId,
          fromNode:  edge.fromNode,
          toNode:    edge.toNode,
          fromT,
          toT,
          direction,
        });
      }

      segmentMap.set(to.stationId, rawSteps.length - 1);
    }

    if (errors.length > 0) return { route: [], segmentMap, errors };

    // ── Merge consecutive same-track, same-direction, contiguous steps ──
    // Collapses station-split sub-edges (forward continuations).
    // Does NOT merge steps with different directions (backtracking preserved).
    const route = _mergeRouteSteps(rawSteps);

    return { route, segmentMap, errors };
  }

  /** Simple version — just the track ID array (for auto-route button). */
  buildStationRouteSimple(stationStops, stations, tracks) {
    const { route } = this.buildStationRoute(stationStops, stations, tracks);
    return route.map(s => s.trackId);
  }

  /**
   * BFS — all track IDs reachable from a starting track.
   * Used for the free-running trains (no station config).
   */
  getConnectedTracks(startTrackId, tracks) {
    this.buildGraph(tracks);

    const nodes = this._trackNodes.get(startTrackId);
    if (!nodes) return [];

    const visited = new Set();
    const result  = new Set();
    const queue   = [nodes.s, nodes.e];

    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);
      for (const edge of (this._adj.get(node) || [])) {
        if (edge.trackId) result.add(edge.trackId);
        if (!visited.has(edge.toNode)) queue.push(edge.toNode);
      }
    }

    return [...result];
  }

  /** Whether a track has any connected track ahead in the given direction. */
  hasTrackAhead(trackId, direction, tracks) {
    const track = tracks.get(trackId);
    if (!track) return false;
    const conns = direction === 1 ? track.connections?.end : track.connections?.start;
    return !!(conns && conns.length > 0);
  }
}

// ─────────────────────────────────────────────────────────
//  Route step merging (module-level helper)
// ─────────────────────────────────────────────────────────

/**
 * Merge consecutive RouteSteps that:
 *   • share the same trackId
 *   • share the same direction
 *   • have contiguous t values (prev.toT ≈ next.fromT)
 *
 * This collapses the sub-edges produced when a station splits a track into
 * two graph segments during the same-direction traversal.
 *
 * Steps in OPPOSITE directions (backtracking) are never merged — they
 * represent physically distinct traversals of the same track.
 */
function _mergeRouteSteps(steps) {
  const merged = [];
  for (const step of steps) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.trackId   === step.trackId &&
      last.direction === step.direction &&
      Math.abs(last.toT - step.fromT) < 0.002
    ) {
      last.toT    = step.toT;
      last.toNode = step.toNode;
    } else {
      merged.push({ ...step });
    }
  }
  return merged;
}
