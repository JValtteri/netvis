# Design Dock

## Overview

NetVis provides a graphical representation of live network traffic on a
2-dimensional canvas. A Go backend captures packets with libpcap, aggregates them
into a host/connection graph, and streams updates to a browser frontend over
WebSockets. The frontend renders the graph as blobs and edges with animated
packets.

## Architecture

### Components

| Component | Path | Responsibility |
| --- | --- | --- |
| CLI | `cmd/netvis/` | Parse flags (`-iface`, `-filter`, `-addr`), start capture and HTTP server, handle shutdown. |
| Capture | `internal/capture/` | Open an interface via libpcap (cgo + gopacket), apply BPF filters, parse L3/L4, emit normalized events. |
| Graph | `internal/graph/` | Thread-safe host/edge store, traffic counters, reverse-DNS cache, snapshots. |
| Server | `internal/server/` | Static file serving, WebSocket upgrade, hub broadcast, client ping/pong. |
| Frontend | `web/static/` | Canvas renderer, force layout, interactions, settings UI. |

### Data flow

```
libpcap ──► capture.Event ──┬──► graph.Apply ──► snapshot (on connect)
                            └──► hub.BroadcastEvent ──► WebSocket ──► canvas
```

### Event model

Each captured packet becomes an event:

```json
{
  "ts": "2026-10-26T12:00:00Z",
  "srcIP": "192.168.1.10",
  "dstIP": "93.184.216.34",
  "proto": "TCP",
  "bytes": 1420
}
```

WebSocket messages are wrapped as `{"type": "packet", "data": <event>}` or
`{"type": "snapshot", "data": {"hosts": [...], "edges": [...]}}`.

## Visualization

### Hosts

- Each observed host is a blob identified by IP (no duplicates) and displayed
  with its IP; the hostname is shown only when reverse DNS resolves (otherwise the
  hostname label is left empty).
- Colour coding:
  - **Green** — local/private-network host.
  - **Blue** — remote/external host.
  - **Grey** — silent host that has not sent a packet.
  - **Dimmed (30% opacity)** — passive host with no traffic sent or received
    within the passive timeout (default 120 s).
  - **Glow** — host that sent a packet within the active glow duration (default
    60 s).
- Blob radius scales with traffic volume (sent + received bytes): the busiest
  host uses the maximum size, the least busy the minimum, others interpolate
  linearly.
- Blob mass is proportional to its radius, so heavier blobs move less in the
  force layout and collision resolution.

### Edges

- Each unique ordered IP pair (source → destination) is an edge.
- Edges are drawn behind hosts and accumulate packet count and byte totals.

### Packets

- Each packet is a particle travelling from source to destination.
- Particle position is recalculated from the live host positions every frame, so
  fast-moving hosts are not missed.
- Colour is determined by protocol: TCP (blue), UDP (green), ICMP (orange),
  other (red).
- Size is derived from packet bytes on a log scale, multiplied by the packet-size
  setting.

### Layout and interactions

- A force layout pulls connected hosts together. Attraction strength depends on
  locality: local↔local, local↔external, external↔external have separate,
  configurable strengths.
- Collision resolution keeps blobs and their labels from overlapping.
- If hosts do not fit the viewport, positions are scaled ("zoomed out") to fit.
- Dragging a blob repositions it and temporarily excludes it from physics.
- Clicking a host or its labels copies the IP to the clipboard and shows a fading
  toast notification.
- The canvas is cleared to opaque black each frame to prevent smearing/trails.

## Frontend controls

### Legend (top-left)

Shows host and protocol colours plus Hosts/Connections counters. A `−`/`+`
button collapses the legend groups while keeping the NetVis title and counters
visible.

### Settings menu (top-right hamburger)

Sliders:

- Attraction local↔local (default 0.100)
- Attraction local↔external (default 0.660)
- Attraction external↔external (default 0.020)
- Packet speed (default 0.005)
- Packet size (default 0.3)
- Min host size (default 5 px)
- Max host size (default 44 px)
- Active glow duration (default 60 s)
- Passive timeout (default 120 s)

Buttons:

- **Remove silent hosts** — hosts that have never sent a packet.
- **Remove passive hosts** — hosts with no activity beyond the passive timeout.

Removing hosts also prunes edges that reference them.

## Project Status

MVP implemented and building. All planned scaffolding, capture, state, backend,
frontend, and integration steps below are complete.

## Steps to a Working Program

### 1) Project scaffolding
- [x] Create standard Go layout (`cmd/netvis/`, `internal/capture/`,
      `internal/graph/`, `internal/server/`, `web/static/`).
- [x] Add `README.md` usage notes (build, permissions, interfaces).
- [x] Define dependencies in `go.mod` (`gopacket` for capture, `gorilla/websocket`
      for realtime).

### 2) Packet capture
- [x] Live interface capture via libpcap with `-iface` and optional BPF filter.
- [x] Parse packets to extract L3/L4: IP (src/dst), protocol (TCP/UDP/ICMP/other),
      length/size.
- [x] Surface permission errors and document root/`CAP_NET_RAW` requirements.
- [x] Emit normalized `{ts, srcIP, dstIP, proto, bytes}` events.

### 3) Graph/state model
- [x] Track hosts by IP with best-effort reverse DNS (cached, short timeout,
      empty on failure).
- [x] Track edges keyed by `srcIP->dstIP` with packet/byte totals.
- [x] Thread-safe access via `sync.RWMutex` for capture-fed state.
- [x] In-memory retained hosts/edges with client snapshots.

### 4) Backend server (API + realtime)
- [x] HTTP server serving static frontend.
- [x] WebSocket hub streaming packet events and initial snapshots.
- [x] Ping/pong keepalive and slow-client handling.
- [x] Same-origin usage; permissive origin check for local development.

### 5) Frontend visualization (2D canvas)
- [x] Canvas renderer with drifting host blobs and force layout.
- [x] Hosts rendered once per IP, avoiding duplicates.
- [x] Edges rendered between IP pairs behind hosts.
- [x] Animated particles with protocol colour and size based on packet bytes.
- [x] WebSocket connection with snapshot + incremental updates.
- [x] Traffic-scaled host sizes, mass-based physics, collision avoidance, fit-to-
      viewport zoom.
- [x] Active glow, passive dimming, and clipboard copy interaction.

### 6) Integration, run, and validation
- [x] Wire capture → state → WebSocket broadcast → frontend.
- [x] CLI flags for interface, BPF filter, and listen address.
- [x] Manual validation on a live interface with generated traffic.
- [x] Document permissions/setup in README.

### MVP acceptance criteria
- [x] Program compiles and runs as `netvis` (`go build ./cmd/netvis`).
- [x] Captures live packets on a specified interface.
- [x] Serves a web UI showing hosts, edges, and animated particles by
      protocol/size.
- [x] No duplicate hosts/edges.

## Open Issues / Future Work

- [ ] Add automated tests for capture parsing, graph aggregation, and hub
      behaviour.
- [ ] Support VLAN/MPLS and improve IPv6 handling.
- [ ] Rate-limit or aggregate events on very busy interfaces to control visual
      noise and CPU load.
- [ ] Move reverse-DNS lookups fully off the graph lock / add a lookup worker.
- [ ] Persist or replay capture sessions (pcap export/import).
- [ ] Throttle/zoom controls for very large graphs beyond fit-to-viewport.
