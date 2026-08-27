/**
 * PathFinder v8 — Junction-aware graph construction.
 *
 * v8 over v7:
 *   Junction nodes are now injected into the routing graph.
 *
 *   Problem fixed:
 *     A branch track whose START is at a junction's mid-point (not at any
 *     track's endpoint) was completely invisible to the graph. PathFinder
 *     could not find a path from tracks on the main line to stations on
 *     such branches, reporting "no track path" even though they were
 *     physically connected via a junction.
 *
 *   Solution:
 *     For each Junction with connectedTrackIds [T1, T2, ...]:
 *       • If the junction sits on a track's endpoint  → use the existing
 *         canonical node (no injection needed).
 *       • If the junction sits at a track's MID-POINT → inject a virtual
 *         node, splitting the track there (exactly like station injection).
 *     Then add zero-weight cross-track edges between all per-track junction
 *     nodes. Dijkstra traverses these edges to switch between tracks at the
 *     junction; path reconstruction ignores them (trackId=null filter)
 *     so they never appear in the RouteStep output.
 *
 *   buildStationRoute() now accepts junctions as a 4th parameter.
 *   The caller (main.js) must pass app.junctions.
 *
 *   All Union-Find connectivity, RouteStep output, and _mergeRouteSteps
 *   logic from v7 are fully preserved.
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
  //  Build graph
  // ─────────────────────────────────────────────────────────

  /**
   * Build the routing graph.
   *
   * @param {Map} tracks
   * @param {Map} [stations]  – injects station coords as virtual nodes
   * @param {Map} [junctions] – injects junction cross-track edges (v8)
   * @returns {Map} stationNodeMap: stationId → nodeId
   */
  buildGraph(tracks, stations = new Map(), junctions = new Map()) {
    this._adj.clear();
    this._nodeCoords.clear();
    this._nodeCounter = 0;
    this._trackNodes.clear();
    this._nodeTbyTrack.clear();

    const trackArr = [...tracks.values()];
    const N        = trackArr.length;
    if (N === 0) return new Map();

    // ── Step 1: Union-Find over raw endpoint indices (0..2N-1) ──
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

      // Primary: track.connections[] (set by autoConnect / rebuildAllConnections)
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

      // Fallback: proximity merge for all track pairs
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
      this._nodeTbyTrack.set(`${s}:${track.id}`, 0);
      this._nodeTbyTrack.set(`${e}:${track.id}`, 1);
    }

    // ── Step 4+5: Collect injection points (stations + mid-track junctions) ──
    //
    // For each junction, determine which of its connected tracks need a
    // mid-point virtual node vs. which already share an endpoint canonical node.
    //
    // ENDPOINT junction  → use existing canonical node (already in graph)
    // MID-POINT junction → inject a new virtual node (splits the track)
    //
    // After injection, zero-weight cross-track edges connect all per-track
    // junction nodes, making Dijkstra able to route between them.

    const JTHRESH = 25; // px — junction snapped within this of a track endpoint

    // junctionPerTrack: junctionId → [ {trackId, nodeId|null, t, isEndpoint} ]
    // nodeId is null for mid-point entries until after injection.
    const junctionPerTrack = new Map();

    // midInjections: trackId → [ {junctionId, t, ref} ]
    // ref is the junctionPerTrack entry we need to back-fill nodeId into.
    const midInjections = new Map();

    for (const [jid, junction] of junctions) {
      const entries = [];
      for (const trackId of junction.connectedTrackIds) {
        const track = tracks.get(trackId);
        if (!track) continue;
        const { s: sn, e: en } = this._trackNodes.get(trackId) || {};
        if (sn === undefined) continue;

        const dS = Math.hypot(junction.x - track.start.x, junction.y - track.start.y);
        const dE = Math.hypot(junction.x - track.end.x,   junction.y - track.end.y);

        if (dS <= JTHRESH) {
          // Junction is at this track's start endpoint → use canonical sn
          entries.push({ trackId, nodeId: sn, t: 0, isEndpoint: true });
        } else if (dE <= JTHRESH) {
          // Junction is at this track's end endpoint → use canonical en
          entries.push({ trackId, nodeId: en, t: 1, isEndpoint: true });
        } else {
          // Junction is at a mid-point of this track → needs injection
          const t   = track.closestT(junction.x, junction.y);
          const ref = { trackId, nodeId: null, t, isEndpoint: false };
          entries.push(ref);
          if (!midInjections.has(trackId)) midInjections.set(trackId, []);
          midInjections.get(trackId).push({ junctionId: jid, t, ref });
        }
      }
      junctionPerTrack.set(jid, entries);
    }

    // ── Station + mid-junction injection loop ──
    const stationsByTrack = new Map();
    for (const [sid, station] of stations) {
      if (!station.trackId) continue;
      if (!stationsByTrack.has(station.trackId)) stationsByTrack.set(station.trackId, []);
      stationsByTrack.get(station.trackId).push({ stationId: sid, t: station.trackT });
    }

    const stationNodeMap = new Map();

    for (let i = 0; i < N; i++) {
      const track      = trackArr[i];
      const tStations  = stationsByTrack.get(track.id)  || [];
      const tJctMids   = midInjections.get(track.id)    || [];

      if (tStations.length === 0 && tJctMids.length === 0) continue;

      const { s: sn, e: en } = this._trackNodes.get(track.id);
      const totalLen = track.getLength() || 1;

      const injectPts = [
        { t: 0, nodeId: sn },
        { t: 1, nodeId: en },
      ];

      // Inject station virtual nodes
      for (const s of tStations) {
        const pt    = track.getPointAt(s.t);
        const vNode = this._newNode(pt);
        injectPts.push({ t: s.t, nodeId: vNode });
        stationNodeMap.set(s.stationId, vNode);
        this._nodeTbyTrack.set(`${vNode}:${track.id}`, s.t);
      }

      // Inject mid-track junction virtual nodes
      for (const j of tJctMids) {
        const pt    = track.getPointAt(j.t);
        const vNode = this._newNode(pt);
        injectPts.push({ t: j.t, nodeId: vNode });
        this._nodeTbyTrack.set(`${vNode}:${track.id}`, j.t);
        j.ref.nodeId = vNode; // back-fill so cross-edge step can use it
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

    // ── Step 6: Cross-track junction edges ──
    // For each junction, connect all its per-track nodes with zero-weight edges.
    // Dijkstra traverses these to switch tracks at the junction.
    // trackId=null marks them as switch edges; path reconstruction ignores them
    // so they never appear in the RouteStep output — only the real track segments do.
    for (const [, entries] of junctionPerTrack) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i];
          const b = entries[j];
          if (a.nodeId !== null && b.nodeId !== null && a.nodeId !== b.nodeId) {
            this._addEdge(a.nodeId, b.nodeId, null, 0);
          }
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
      // trackId=null means a junction cross-edge — skip it in the output.
      // Dijkstra used it to switch tracks; Train uses _switchJunctionForTransition.
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
   * @param {Array} stationStops  [{stationId, stationName}, ...]
   * @param {Map}   stations
   * @param {Map}   tracks
   * @param {Map}   [junctions]   — pass app.junctions to enable junction routing
   * @returns {{ route: RouteStep[], segmentMap: Map, errors: string[] }}
   */
  buildStationRoute(stationStops, stations, tracks, junctions = new Map()) {
    if (stationStops.length < 1) return { route: [], segmentMap: new Map(), errors: [] };

    const stationNodeMap = this.buildGraph(tracks, stations, junctions);

    const rawSteps   = [];
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

        const fromT = this._nodeTbyTrack.get(`${edge.fromNode}:${edge.trackId}`) ?? 0;
        const toT   = this._nodeTbyTrack.get(`${edge.toNode}:${edge.trackId}`)   ?? 1;

        if (Math.abs(toT - fromT) < 0.0001) continue; // zero-length step

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

    const route = _mergeRouteSteps(rawSteps);
    return { route, segmentMap, errors };
  }

  /** Simple version — track ID array only (for auto-route / BFS buttons). */
  buildStationRouteSimple(stationStops, stations, tracks, junctions = new Map()) {
    const { route } = this.buildStationRoute(stationStops, stations, tracks, junctions);
    return route.map(s => s.trackId);
  }

  /**
   * BFS — all track IDs reachable from a starting track.
   * Passes junctions so cross-track edges are included in the BFS.
   */
  getConnectedTracks(startTrackId, tracks, junctions = new Map()) {
    this.buildGraph(tracks, new Map(), junctions);

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
 * Merge consecutive RouteSteps that share the same trackId, same direction,
 * and contiguous t values (prev.toT ≈ next.fromT).
 *
 * Collapses station-split sub-edges for same-direction traversal.
 * Steps in OPPOSITE directions (backtracking) are never merged.
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
