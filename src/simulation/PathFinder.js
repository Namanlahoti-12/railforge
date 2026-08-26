/**
 * PathFinder — graph representation of track network and route computation.
 * v3: Fixed node key rounding, improved station-to-station routing.
 */
export class PathFinder {
  constructor() {
    this.graph = new Map(); // nodeId → [{ trackId, neighborNodeId, weight }]
    this._nodeMap = null;
  }

  /** Round to nearest 5 for more forgiving node matching */
  _pointKey(p) {
    const r = 5; // snap to nearest 5 units
    return `${Math.round(p.x / r) * r},${Math.round(p.y / r) * r}`;
  }

  /** Rebuild graph from tracks */
  buildGraph(tracks) {
    this.graph.clear();
    const nodeMap = new Map(); // "x,y" → nodeId
    let nodeCounter = 0;

    const getNode = (p) => {
      const key = this._pointKey(p);
      if (!nodeMap.has(key)) {
        nodeMap.set(key, nodeCounter++);
        this.graph.set(nodeMap.get(key), []);
      }
      return nodeMap.get(key);
    };

    for (const [, track] of tracks) {
      const startNode = getNode(track.start);
      const endNode = getNode(track.end);
      const weight = track.getLength();

      this.graph.get(startNode).push({
        trackId: track.id,
        neighbor: endNode,
        weight,
      });
      this.graph.get(endNode).push({
        trackId: track.id,
        neighbor: startNode,
        weight,
      });
    }

    this._nodeMap = nodeMap;
  }

  /** Find nearest graph node to a world point */
  _findNearestNode(pt) {
    // First try exact match
    const key = this._pointKey(pt);
    if (this._nodeMap?.has(key)) return this._nodeMap.get(key);

    // Fallback: brute-force search for closest node
    let bestNode = undefined;
    let bestDist = Infinity;
    for (const [keyStr, nodeId] of (this._nodeMap || new Map())) {
      const [kx, ky] = keyStr.split(',').map(Number);
      const d = Math.hypot(pt.x - kx, pt.y - ky);
      if (d < bestDist) { bestDist = d; bestNode = nodeId; }
    }
    return bestDist < 50 ? bestNode : undefined;
  }

  /** Find shortest path between two world points → array of track IDs */
  findRoute(startPt, endPt, tracks) {
    this.buildGraph(tracks);

    const startNode = this._findNearestNode(startPt);
    const endNode = this._findNearestNode(endPt);

    if (startNode === undefined || endNode === undefined) return [];
    if (startNode === endNode) return [];

    // Dijkstra's algorithm
    const dist = new Map();
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();

    for (const [n] of this.graph) {
      dist.set(n, Infinity);
    }
    dist.set(startNode, 0);

    const queue = [startNode];

    while (queue.length > 0) {
      queue.sort((a, b) => dist.get(a) - dist.get(b));
      const u = queue.shift();

      if (visited.has(u)) continue;
      visited.add(u);

      if (u === endNode) break;

      for (const edge of (this.graph.get(u) || [])) {
        const alt = dist.get(u) + edge.weight;
        if (alt < dist.get(edge.neighbor)) {
          dist.set(edge.neighbor, alt);
          prev.set(edge.neighbor, u);
          prevEdge.set(edge.neighbor, edge.trackId);
          queue.push(edge.neighbor);
        }
      }
    }

    // Reconstruct path
    const route = [];
    let node = endNode;
    while (prev.has(node)) {
      route.unshift(prevEdge.get(node));
      node = prev.get(node);
    }

    return route;
  }

  /** 
   * Find route between two stations via their track positions.
   * Returns an array of track IDs forming the path.
   */
  findRouteBetweenStations(fromStation, toStation, tracks) {
    if (!fromStation?.trackId || !toStation?.trackId) return [];
    
    const fromTrack = tracks.get(fromStation.trackId);
    const toTrack = tracks.get(toStation.trackId);
    if (!fromTrack || !toTrack) return [];

    // If both stations are on the same track
    if (fromStation.trackId === toStation.trackId) {
      return [fromStation.trackId];
    }

    // Build graph
    this.buildGraph(tracks);

    // Try routing from both endpoints of from-track to both endpoints of to-track
    const fromEndpoints = [fromTrack.start, fromTrack.end];
    const toEndpoints = [toTrack.start, toTrack.end];

    let bestRoute = [];
    let bestLength = Infinity;

    for (const sp of fromEndpoints) {
      for (const ep of toEndpoints) {
        const startNode = this._findNearestNode(sp);
        const endNode = this._findNearestNode(ep);

        if (startNode === undefined || endNode === undefined) continue;
        if (startNode === endNode) {
          // Adjacent tracks — just need both
          bestRoute = [fromStation.trackId, toStation.trackId];
          bestLength = 0;
          continue;
        }

        // Run Dijkstra inline to avoid rebuilding graph
        const dist = new Map();
        const prev = new Map();
        const prevEdge = new Map();
        const visited = new Set();

        for (const [n] of this.graph) dist.set(n, Infinity);
        dist.set(startNode, 0);
        const queue = [startNode];

        while (queue.length > 0) {
          queue.sort((a, b) => dist.get(a) - dist.get(b));
          const u = queue.shift();
          if (visited.has(u)) continue;
          visited.add(u);
          if (u === endNode) break;

          for (const edge of (this.graph.get(u) || [])) {
            const alt = dist.get(u) + edge.weight;
            if (alt < dist.get(edge.neighbor)) {
              dist.set(edge.neighbor, alt);
              prev.set(edge.neighbor, u);
              prevEdge.set(edge.neighbor, edge.trackId);
              queue.push(edge.neighbor);
            }
          }
        }

        const route = [];
        let node = endNode;
        while (prev.has(node)) {
          route.unshift(prevEdge.get(node));
          node = prev.get(node);
        }

        if (route.length > 0) {
          let totalLen = 0;
          for (const tid of route) {
            const t = tracks.get(tid);
            if (t) totalLen += t.getLength();
          }
          if (totalLen < bestLength) {
            bestLength = totalLen;
            bestRoute = route;
          }
        }
      }
    }

    // Ensure from-track at start and to-track at end
    if (bestRoute.length > 0) {
      if (bestRoute[0] !== fromStation.trackId) {
        bestRoute.unshift(fromStation.trackId);
      }
      if (bestRoute[bestRoute.length - 1] !== toStation.trackId) {
        bestRoute.push(toStation.trackId);
      }
      // Remove consecutive duplicates
      bestRoute = bestRoute.filter((id, i) => i === 0 || id !== bestRoute[i - 1]);
    }

    return bestRoute;
  }

  /**
   * Build a full route from an ordered list of station stops.
   * Returns the concatenated track IDs for the entire journey.
   */
  buildStationRoute(stationStops, stations, tracks) {
    if (stationStops.length < 2) return [];

    this.buildGraph(tracks);

    const fullRoute = [];
    for (let i = 0; i < stationStops.length - 1; i++) {
      const fromStation = stations.get(stationStops[i].stationId);
      const toStation = stations.get(stationStops[i + 1].stationId);
      if (!fromStation || !toStation) continue;

      const segment = this.findRouteBetweenStations(fromStation, toStation, tracks);
      
      // Merge segment into full route, avoiding duplicates
      for (const trackId of segment) {
        if (fullRoute.length === 0 || fullRoute[fullRoute.length - 1] !== trackId) {
          fullRoute.push(trackId);
        }
      }
    }

    return fullRoute;
  }

  /** Check if there's track connectivity ahead of a position */
  hasTrackAhead(trackId, direction, tracks) {
    const track = tracks.get(trackId);
    if (!track) return false;

    const connections = direction === 1 ? track.connections.end : track.connections.start;
    return connections.length > 0;
  }

  /** Get all connected track IDs from a starting track (BFS) */
  getConnectedTracks(startTrackId, tracks) {
    this.buildGraph(tracks);
    const connected = new Set();
    const visited = new Set();
    const queue = [];

    for (const [, track] of tracks) {
      if (track.id === startTrackId) {
        const sNode = this._findNearestNode(track.start);
        const eNode = this._findNearestNode(track.end);
        if (sNode !== undefined) queue.push(sNode);
        if (eNode !== undefined) queue.push(eNode);
        break;
      }
    }

    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);

      for (const edge of (this.graph.get(node) || [])) {
        connected.add(edge.trackId);
        if (!visited.has(edge.neighbor)) {
          queue.push(edge.neighbor);
        }
      }
    }

    return [...connected];
  }
}
