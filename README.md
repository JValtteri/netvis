# NetVis — Network Traffic Visualizer

A live, graphical representation of network traffic. NetVis captures packets from a
network interface with libpcap, aggregates them into a host/connection graph, and
streams updates to a browser-based 2D canvas over WebSockets.

- Hosts are drawn as blobs labelled with their IP address (and hostname when
  reverse DNS resolves).
- Each unique source → destination IP pair becomes an edge.
- Every captured packet is animated as a particle travelling along its edge; the
  colour encodes the protocol and the size encodes the packet size.

## Requirements

- Go 1.23 or newer
- Linux with `libpcap` development headers (cgo is used)
- Root privileges or `CAP_NET_RAW`/`CAP_NET_ADMIN` for live capture

Install libpcap headers on Debian/Ubuntu:

```bash
sudo apt install libpcap-dev
```

On Fedora/RHEL:

```bash
sudo dnf install libpcap-devel
```

On Arch:

```bash
sudo pacman -S libpcap
```

## Build

```bash
go build -o netvis ./cmd/netvis
```

The resulting `netvis` binary is placed in the current directory (it is already
listed in `.gitignore`).

## Run

```bash
sudo ./netvis -iface <interface> [-filter "<BPF filter>"] [-addr ":8080"]
```

Example:

```bash
sudo ./netvis -iface wlan0
sudo ./netvis -iface eth0 -filter "tcp port 443" -addr ":9090"
```

Open <http://localhost:8080> (or the address given with `-addr`) in a browser.

Run the binary from the repository root (or wherever `web/static/` is available),
because the server serves the frontend from `web/static/` relative to the current
working directory.

### Flags

| Flag | Required | Description |
| --- | --- | --- |
| `-iface` | yes | Network interface to capture on (e.g. `eth0`, `wlan0`, `any`). |
| `-filter` | no | BPF capture filter, e.g. `tcp port 80`, `udp`, `host 192.168.1.10`. |
| `-addr` | no | HTTP listen address, defaults to `:8080`. |

### Finding an interface

```bash
ip link show          # Linux
```

You can also run with `-iface any` on Linux to capture across all interfaces.

### Running without root

Instead of `sudo`, you can grant the binary capture capabilities:

```bash
sudo setcap cap_net_raw,cap_net_admin=eip ./netvis
./netvis -iface eth0
```

Note that re-building the binary replaces it and drops the capabilities, so
re-apply `setcap` after each build.

## Using the UI

### Canvas

- **Colour of host blobs**
  - Green: local/private network host
  - Blue: remote/external host
  - Grey: host that has not sent any packets (silent)
  - Dimmed: passive host, no traffic sent or received recently
  - Glowing: host that sent a packet within the recent activity window
- **Blob size** scales with traffic volume: the busiest host is the largest and
  the least busy the smallest.
- **Edges** connect IP pairs; particles travel source → destination.
- **Dragging** a blob repositions it; connected hosts pull toward each other via a
  force layout.
- **Clicking** a host (blob or label) copies its IP address to the clipboard and
  shows a short confirmation toast.

### Legend

The top-left panel shows host and protocol colour legends. Use the `−`/`+`
button in its header to collapse the legend, leaving only the NetVis title and
the Hosts/Connections counters visible.

### Settings menu

Use the hamburger button in the top-right corner to open the settings panel.

| Setting | Default | Description |
| --- | --- | --- |
| Attraction local↔local | 0.100 | Force between two local hosts. |
| Attraction local↔external | 0.660 | Force between a local and an external host. |
| Attraction external↔external | 0.020 | Force between two external hosts. |
| Packet speed | 0.005 | How fast particles travel along edges. |
| Packet size | 0.3 | Scale factor for particle size. |
| Min host size | 5 | Smallest blob radius. |
| Max host size | 44 | Largest blob radius. |
| Active glow duration | 60 s | How long a host glows after sending a packet. |
| Passive after | 120 s | Inactivity period before a host is dimmed as passive. |

Buttons:

- **Remove silent hosts** — removes hosts that have never sent a packet.
- **Remove passive hosts** — removes hosts with no traffic within the passive
  timeout.

## Project layout

```
cmd/netvis/          CLI entry point and flag parsing
internal/capture/    libpcap packet capture and parsing (gopacket)
internal/graph/      Host/edge state, reverse-DNS cache, snapshots
internal/server/     HTTP server, WebSocket hub and clients
web/static/          Frontend (HTML, CSS, canvas/JS)
DESIGN.md            Design document and implementation notes
```

## How it works

1. `capture` opens the interface with libpcap, applies an optional BPF filter and
   emits normalized events: `{ts, srcIP, dstIP, proto, bytes}`.
2. `graph` records hosts (IP + best-effort hostname) and edges keyed by
   `srcIP->dstIP`, accumulating packet counts and byte totals.
3. `server` broadcasts each event to connected WebSocket clients and sends a
   full snapshot when a client connects.
4. The frontend renders the snapshot, then applies live packet events, animating
   particles and running a simple force layout on the canvas.

## Troubleshooting

**`pcap.h: No such file or directory`** — install the libpcap development package
listed above (the runtime library alone is not enough).

**`pcap.OpenLive: ... permission denied`** — run with `sudo` or grant
`cap_net_raw,cap_net_admin` as shown above.

**No packets appear** — check the interface name, make sure traffic matches the
BPF filter, and confirm the browser is connected (browser dev-tools WebSocket).
Loopback traffic may need `-iface lo`.

**Reverse DNS is slow** — lookups are best-effort with a short timeout; hosts
without a resolvable name are shown with an empty hostname.
