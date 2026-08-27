/**
 * PathFinder v5 — Connection-aware shortest-path routing.
 *
 * Key fixes over v4:
 *  1. Graph is built using track.connections[] (populated by autoConnect with 20-unit
 *     tolerance) instead of coordinate-snap — branch tracks at junctions now connect
 *     correctly even if endpoint coordinates differ by a few pixels.
 *  2. buildStationRoute() returns an `errors` array with per-leg human-readable messages
 *     when no track path exists between two stations.
 *  3. Station virtual nodes are still injected at exact (x,y) as before.
 */
export class PathFinder {
  constructor() {
    // nodeId  →  [ { trackId, toNode, weight } ]
    this._adj = new Map();
    // "x,y" key → nodeId  (used for exact-coord lookup)
    this._nodeMap = new Map();
    this._nodeCoords = new Map();  // nodeId → {x, y}
    this._nodeCounter = 0;
  }

  // ─────────────────────────────────────────────────────────
  //  Internal graph helpers
  // ─────────────────────────────────────────────────────────

  _snap(v) { return Math.round(v); }
  _key(p)  { return `${this._snap(p.x)},${this._snap(p.y)}`; }

  /**
   * Standard node creation by exact coordinate key.
   * Used for station virtual nodes where precision matters.
   */
  _getOrCreateNode(p) {
    const k = this._key(p);
    if (!this._nodeMap.has(k)) {
      const id = this._nodeCounter++;
      this._nodeMap.set(k, id);
      this._nodeCoords.set(id, { x: p.x, y: p.y });
      this._adj.set(id, []);
    }
    return this._nodeMap.get(k);
  }

  /**
   * Tolerant node creation — merges with any existing node within CONNECT_THRESHOLD.
   * This matches autoConnect()'s 20-unit threshold so the graph reflects exactly
   * the same connectivity that was established when tracks were placed.
   */
  _getOrCreateNodeTolerant(p) {
    const CONNECT_THRESHOLD = 20;
    for (const [nodeId, coords] of this._nodeCoords) {
      if (Math.hypot(p.x - coords.x, p.y - coords.y) < CONNECT_THRESHOLD) {
        return nodeId;
      }
    }
    return this._getOrCreateNode(p);
  }

  _addEdge(fromNode, toNode, trackId, weight) {
    this._adj.get(fromNode).push({ toNode, trackId, weight });
    this._adj.get(toNode).push({ toNode: fromNode, trackId, weight });
  }

  // ─────────────────────────────────────────────────────────
  //  Build graph from tracks + inject station virtual nodes
  // ─────────────────────────────────────────────────────────

  /**
   * Build the routing graph.
   * @param {Map} tracks
   * @param {Map} [stations]  – optional; injects station coords as virtual nodes
   * @returns {Map} stationNodeMap: stationId → nodeId
   */
  buildGraph(tracks, stations = new Map()) {
    this._adj.clear();
    this._nodeMap.clear();
    this._nodeCoords.clear();
    this._nodeCounter = 0;

    // ── Step 1: Create endpoint nodes for every track (tolerant merge) ──
    // This ensures that two track endpoints placed within 20 units of each other
    // (i.e. "connected" per autoConnect) share the SAME graph node.
    for (const [, track] of tracks) {
      this._getOrCreateNodeTolerant(track.start);
      this._getOrCreateNodeTolerant(track.end);
    }

    // ── Step 2: Add a graph edge for each track segment ──
    for (const [, track] of tracks) {
      const totalLen = track.getLength() || 1;
      const startNode = this._getOrCreateNodeTolerant(track.start);
      const endNode   = this._getOrCreateNodeTolerant(track.end);
      if (startNode !== endNode) {
        this._addEdge(startNode, endNode, track.id, totalLen);
      }
    }

    // ── Step 3: Inject station virtual nodes (exact precision) ──
    // Collect which station(s) sit on each track
    const stationsByTrack = new Map(); // trackId → [{stationId, t, x, y}]
    for (const [sid, station] of stations) {
      if (!station.trackId) continue;
      if (!stationsByTrack.has(station.trackId)) stationsByTrack.set(station.trackId, []);
      stationsByTrack.get(station.trackId).push({
        stationId: sid,
        t: station.trackT,
        x: station.x,
        y: station.y,
      });
    }

    const stationNodeMap = new Map(); // stationId → nodeId

    for (const [, track] of tracks) {
      const trackStations = stationsByTrack.get(track.id) || [];
      if (trackStations.length === 0) continue;

      const totalLen  = track.getLength() || 1;
      const startNode = this._getOrCreateNodeTolerant(track.start);
      const endNode   = this._getOrCreateNodeTolerant(track.end);

      // Build injection point list: track start + station midpoints + track end
      const injectPts = [
        { t: 0, nodeId: startNode },
        { t: 1, nodeId: endNode },
      ];

      for (const s of trackStations) {
        const pt     = track.getPointAt(s.t);
        const nodeId = this._getOrCreateNode(pt); // exact position for stations
        injectPts.push({ t: s.t, nodeId });
        stationNodeMap.set(s.stationId, nodeId);
      }

      // Sort by t and link adjacent points with partial-length edges
      injectPts.sort((a, b) => a.t - b.t);

      // Remove existing direct edge between startNode and endNode —
      // we'll replace it with the segmented version through station nodes.
      this._removeEdge(startNode, endNode, track.id);

      for (let i = 0; i < injectPts.length - 1; i++) {
        const a = injectPts[i];
        const b = injectPts[i + 1];
        const segWeight = (b.t - a.t) * totalLen;
        if (a.nodeId !== b.nodeId && segWeight > 0) {
          this._addEdge(a.nodeId, b.nodeId, track.id, segWeight);
        }
      }
    }

    return stationNodeMap;
  }

  /** Remove a specific edge between two nodes (both directions). */
  _removeEdge(fromNode, toNode, trackId) {
    const removeFrom = this._adj.get(fromNode);
    if (removeFrom) {
      const idx = removeFrom.findIndex(e => e.toNode === toNode && e.trackId === trackId);
      if (idx >= 0) removeFrom.splice(idx, 1);
    }
    const removeTo = this._adj.get(toNode);
    if (removeTo) {
      const idx = removeTo.findIndex(e => e.toNode === fromNode && e.trackId === trackId);
      if (idx >= 0) removeTo.splice(idx, 1);
    }
  }

  // ─────────────────────────────────────────────────────────
  //  Dijkstra
  // ─────────────────────────────────────────────────────────

  /**
   * Find the shortest path between two node IDs.
   * Returns array of { trackId, fromNode, toNode } edges in order.
   */
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

    if (!prev.has(targetNode)) return null; // unreachable

    const edges = [];
    let cur = targetNode;
    while (prev.has(cur)) {
      const { fromNode, trackId } = prev.get(cur);
      if (trackId !== null) {
        // Skip zero-weight bridge edges (null trackId)
        edges.unshift({ trackId, fromNode, toNode: cur });
      }
      cur = fromNode;
    }
    return edges;
  }

  // ─────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────

  /**
   * Build the full ordered route (array of track IDs) for a
   * multi-stop station sequence, using Dijkstra on coordinates.
   *
   * Key design:
   *  - Branch stations (near the dead-end tip of a track) require the train to
   *    BACKTRACK through the same track to return to the junction. The route
   *    must include that track TWICE — once going in, once coming back out.
   *  - Middle-of-track stations (train passes through and continues) should NOT
   *    repeat the track — the train naturally continues after dwelling.
   *
   *  The deduplication at leg boundaries must distinguish these two cases by
   *  checking whether the first edge of a new leg goes FORWARD (skip) or
   *  BACKWARD / backtracking (keep both occurrences).
   *
   * @param {Array}  stationStops  [{stationId, stationName}, ...]
   * @param {Map}    stations      all Station objects
   * @param {Map}    tracks        all Track objects
   * @returns {{ route: string[], segmentMap: Map, errors: string[] }}
   */
  buildStationRoute(stationStops, stations, tracks) {
    if (stationStops.length < 1) return { route: [], segmentMap: new Map(), errors: [] };

    const stationNodeMap = this.buildGraph(tracks, stations);

    const fullRoute  = [];
    const segmentMap = new Map();
    const errors     = [];

    // Track the graph-node traversal across legs so we can detect direction changes
    // at leg boundaries (determines whether same-track duplicates are backtracks).
    let lastEdgeEntryNode = null;  // fromNode of the last edge added to fullRoute
    let lastEdgeExitNode  = null;  // toNode  of the last edge added to fullRoute

    for (let i = 0; i < stationStops.length - 1; i++) {
      const from = stationStops[i];
      const to   = stationStops[i + 1];

      const fromNode = stationNodeMap.get(from.stationId);
      const toNode   = stationNodeMap.get(to.stationId);

      // ── Validate station placement ──
      if (fromNode === undefined) {
        errors.push(`⚠ "${from.stationName}" is not placed on any track`);
        continue;
      }
      if (toNode === undefined) {
        errors.push(`⚠ "${to.stationName}" is not placed on any track`);
        continue;
      }

      if (i === 0) {
        segmentMap.set(from.stationId, fullRoute.length);
      }

      const edges = this._dijkstra(fromNode, toNode);

      // ── Per-leg error if no path ──
      if (!edges || edges.length === 0) {
        errors.push(
          `❌ No track path from "${from.stationName}" → "${to.stationName}". ` +
          `Lay connected track between them and try again.`
        );
        continue;
      }

      for (let j = 0; j < edges.length; j++) {
        const edge = edges[j];
        if (!edge.trackId) continue;

        const isSameTrackAsLast = (
          fullRoute.length > 0 &&
          fullRoute[fullRoute.length - 1] === edge.trackId
        );

        if (j === 0 && isSameTrackAsLast) {
          // ── Leg-boundary same-track decision ──
          //
          // Case A — BACKTRACK (keep both):
          //   The first edge of this new leg goes toward lastEdgeEntryNode
          //   (the node we entered the previous occurrence of this track FROM).
          //   This means the train reached a dead-end (branch tip) and must
          //   REVERSE through the same track back to the junction.
          //   Example: S2 on branch tip → next leg must go back through branch.
          //
          // Case B — FORWARD CONTINUATION (skip):
          //   The first edge goes away from lastEdgeEntryNode (deeper into the
          //   track's second half). The train naturally continues after dwelling;
          //   no extra entry needed.

          const isBacktrack = (edge.toNode === lastEdgeEntryNode);

          if (!isBacktrack) {
            // Forward continuation: update traversal tracking but don't add
            lastEdgeEntryNode = edge.fromNode;
            lastEdgeExitNode  = edge.toNode;
            continue;
          }
          // Backtrack: fall through and add the edge (track appears twice in route)
        }

        fullRoute.push(edge.trackId);
        lastEdgeEntryNode = edge.fromNode;
        lastEdgeExitNode  = edge.toNode;
      }

      segmentMap.set(to.stationId, fullRoute.length - 1);
    }

    return { route: fullRoute, segmentMap, errors };
  }

  /**
   * Simple version: returns just the track ID array.
   * Used for the "auto-route all connected" button.
   */
  buildStationRouteSimple(stationStops, stations, tracks) {
    const { route } = this.buildStationRoute(stationStops, stations, tracks);
    return route;
  }

  /** Find all track IDs reachable from a starting track (BFS). Used for free-running. */
  getConnectedTracks(startTrackId, tracks) {
    this.buildGraph(tracks);

    const startTrack = tracks.get(startTrackId);
    if (!startTrack) return [];

    const startNodeA = this._getOrCreateNodeTolerant(startTrack.start);
    const startNodeB = this._getOrCreateNodeTolerant(startTrack.end);

    const visited = new Set();
    const result  = new Set();
    const queue   = [startNodeA, startNodeB];

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

  /** Check if any track is connected ahead in a given direction. */
  hasTrackAhead(trackId, direction, tracks) {
    const track = tracks.get(trackId);
    if (!track) return false;
    const connections = direction === 1 ? track.connections.end : track.connections.start;
    return connections.length > 0;
  }
}
