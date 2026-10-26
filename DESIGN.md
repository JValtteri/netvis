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
| Graph | `internal/graph/` | Thread-safe host/edge store, traffic counters, async display-name resolution (reverse DNS for local hosts, whois organization with reverse-DNS fallback for external hosts), snapshots. |
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

WebSocket messages are wrapped as:

- `{"type": "packet", "data": <event>}`
- `{"type": "snapshot", "data": {"hosts": [...], "edges": [...], "serverIPs": [...], "webPort": 8080}}`
- `{"type": "host", "data": <host>}` — sent when a host's display name is resolved
  asynchronously.

## Visualization

### Hosts

- Each observed host is a blob identified by IP (no duplicates) and displayed
  with its IP.
- Display name resolution is asynchronous and cached:
  - **Local/private hosts** use reverse DNS for a hostname (3 s timeout).
  - **External hosts** use a whois lookup: query `whois.iana.org` for the
    authoritative RIR server, then query that server and extract the
    organization (`org-name`, `OrgName`, `organization`, `owner`, `descr`, or
    `netname`). If no organization is found, reverse DNS is used as a fallback.
  - If no name is available the label is left empty. Resolution results are
    pushed to clients as `host` messages and fill in the label when they arrive.
- Colour coding:
  - **Green** — local/private-network host.
  - **Blue** — remote/external host.
  - **Grey** — silent host that has not sent a packet.
  - **Dimmed (30% opacity)** — passive host with no traffic sent or received
    within the passive timeout (default 120 s).
  - **Glow** — host that sent a packet within the active glow duration (default
    10 s). The glow fades in on activity and fades out smoothly instead of
    toggling abruptly.
- Blob radius scales with traffic volume (sent + received bytes): the busiest
  host uses the maximum size, the least busy the minimum, others interpolate
  linearly.
- Blob mass is proportional to its radius, so heavier blobs move less in the
  force layout and collision resolution.

### Edges

- Each unique ordered IP pair (source → destination) is an edge.
- Edges are drawn behind hosts and accumulate packet count and byte totals.
- Only TCP connections to the NetVis frontend on its web port (reported in the
  snapshot as `webPort`) that involve one of the server's addresses are rendered
  as a thin glowing yellow line. Other traffic to/from the server machine is
  treated normally.

### Packets

- Each packet is a particle travelling from source to destination, except
  TCP connections to the NetVis frontend, which have no particles (the glowing
  edge represents them).
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
- Collision resolution uses each host's combined blob + IP/hostname label
  bounding box as a soft repulsion (a fraction of the overlap is resolved per
  frame). The collision area scales with the rendered label content, with extra
  vertical spacing so IP/hostname labels on nearby hosts don't touch.
- Long IPv6 address labels are truncated for display; copying a host still uses
  the full address.
- Blob velocity is damped by drag, so blobs settle instead of creeping forward.
- The view is controlled by a camera (scale + offset) rather than by scaling host
  positions. Zoom/fit leaves graph coordinates independent of the viewport.
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
- Active glow duration (default 10 s)
- Passive timeout (default 120 s)
- Auto-remove passive hosts (checkbox, off by default; checked hosts are pruned
  continuously once they become passive)

Buttons:

- **Remove silent hosts** — hosts that have never sent a packet.
- **Remove passive hosts** — hosts with no activity beyond the passive timeout.

Removing hosts also prunes edges that reference them.

### View controls (bottom-right)

- `+` / `−` buttons zoom in and out around the viewport centre.
- The frame button fits all hosts and their labels into view.
- The mouse wheel zooms toward the cursor; on touch devices a two-finger pinch
  zooms and pans while one finger drags a host.

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
- [x] Track hosts by IP with async, cached display-name resolution: reverse DNS
      for local hosts and whois organization for external hosts (timeouts, empty
      on failure, pushed to clients via `host` messages).
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
- [x] Traffic-scaled host sizes, mass-based physics, label-aware collision
      avoidance, drag/friction, and camera zoom with fit-to-view.
- [x] Active glow, passive dimming, clipboard copy, and server-edge highlighting.

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

- [x] Add automated tests for capture parsing, graph aggregation, and hub
      behaviour.
- [ ] Support VLAN/MPLS and improve IPv6 handling.
- [ ] Rate-limit or aggregate events on very busy interfaces to control visual
      noise and CPU load.
- [ ] Rate-limit/cache whois lookups more aggressively and add a bounded lookup
      worker pool for very large host sets.
- [ ] Persist or replay capture sessions (pcap export/import).
- [ ] Throttle controls for very busy graphs.
