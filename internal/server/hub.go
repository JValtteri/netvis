package server

import (
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"netvis/internal/capture"
	"netvis/internal/graph"
)

const (
	// batchInterval bounds how long packet events wait before being sent to
	// clients. It is deliberately a fixed window rather than a debounce, so
	// sustained traffic cannot keep postponing the flush indefinitely.
	batchInterval = 16 * time.Millisecond
	// maxBatchEvents bounds the memory used by an individual batch and prevents
	// a large burst from blocking the client for too long.
	maxBatchEvents = 2048
)

// trafficKey identifies one aggregated traffic stream: a directed host pair,
// protocol, and whether the packet is part of a NetVis frontend connection.
// Keeping the frontend flag in the key prevents frontend traffic from being
// merged with ordinary traffic on the same edge.
type trafficKey struct {
	SrcIP    string
	DstIP    string
	Proto    string
	Frontend bool
}

type trafficRecord struct {
	SrcIP    string `json:"srcIP"`
	DstIP    string `json:"dstIP"`
	Proto    string `json:"proto"`
	Frontend bool   `json:"frontend,omitempty"`
	Count    int    `json:"count"`
	Bytes    int64  `json:"bytes"`
}

type Hub struct {
	clients      map[*Client]bool
	broadcast    chan []byte
	register     chan *Client
	unregister   chan *Client
	g            *graph.Graph
	serverIPs    []string
	webPort      int
	mu           sync.RWMutex
	pendingBatch [][]byte

	trafficMu      sync.Mutex
	pendingTraffic map[trafficKey]*trafficRecord
}

func NewHub(g *graph.Graph, addr string) *Hub {
	h := &Hub{
		clients:        make(map[*Client]bool),
		broadcast:      make(chan []byte),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		g:              g,
		serverIPs:      detectServerIPs(),
		webPort:        extractPort(addr),
		pendingBatch:   make([][]byte, 0, 32),
		pendingTraffic: make(map[trafficKey]*trafficRecord),
	}
	return h
}

// extractPort parses the port from an address like ":3993", "0.0.0.0:3993", or "[::]:3993".
func extractPort(addr string) int {
	defaultPort := 3993
	if addr == "" {
		return defaultPort
	}
	// Handle IPv6 addresses
	if strings.HasPrefix(addr, "[") {
		if idx := strings.LastIndex(addr, ":"); idx != -1 {
			if p, err := strconv.Atoi(addr[idx+1 : len(addr)-1]); err == nil {
				return p
			}
		}
		return defaultPort
	}
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		if p, err := strconv.Atoi(addr[idx+1:]); err == nil {
			return p
		}
	}
	return defaultPort
}

// detectServerIPs returns the addresses assigned to this machine, across all
// interfaces. Traffic between these addresses and other hosts is local to the
// NetVis server itself.
func detectServerIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}

	seen := make(map[string]bool)
	ips := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var ip net.IP
		switch v := addr.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil {
			continue
		}
		s := ip.String()
		if seen[s] {
			continue
		}
		seen[s] = true
		ips = append(ips, s)
	}
	return ips
}

func (h *Hub) Run() {
	ticker := time.NewTicker(batchInterval)
	defer ticker.Stop()

	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = true
			h.mu.Unlock()
			// send snapshot
			snap := h.g.Snapshot()
			snap.ServerIPs = h.serverIPs
			snap.WebPort = h.webPort
			if b, err := json.Marshal(map[string]interface{}{
				"type": "snapshot",
				"data": snap,
			}); err == nil {
				c.send <- b
			}
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			h.pendingBatch = append(h.pendingBatch, msg)
			if len(h.pendingBatch) >= maxBatchEvents {
				h.flushBatch()
			}
		case <-ticker.C:
			h.flushBatch()
		}
	}
}

func (h *Hub) flushBatch() {
	traffic := h.takeTraffic()
	if len(traffic) == 0 && len(h.pendingBatch) == 0 {
		return
	}
	batch := h.pendingBatch
	h.pendingBatch = make([][]byte, 0, 32)

	messages := make([]json.RawMessage, 0, len(batch)+1)
	if len(traffic) > 0 {
		payload, err := json.Marshal(struct {
			Type string          `json:"type"`
			Data []trafficRecord `json:"data"`
		}{
			Type: "traffic",
			Data: traffic,
		})
		if err == nil {
			messages = append(messages, json.RawMessage(payload))
		}
	}
	for _, b := range batch {
		messages = append(messages, json.RawMessage(b))
	}
	if len(messages) == 0 {
		return
	}
	if len(messages) == 1 {
		h.broadcastDirect(messages[0])
		return
	}
	wrapped, err := json.Marshal(struct {
		Type string            `json:"type"`
		Data []json.RawMessage `json:"data"`
	}{
		Type: "batch",
		Data: messages,
	})
	if err != nil {
		for _, msg := range messages {
			h.broadcastDirect(msg)
		}
		return
	}
	h.broadcastDirect(wrapped)
}

// takeTraffic atomically swaps out the current aggregate window. BroadcastEvent
// runs on the capture goroutine while flushBatch runs on the hub goroutine, so
// the map needs its own lock.
func (h *Hub) takeTraffic() []trafficRecord {
	h.trafficMu.Lock()
	defer h.trafficMu.Unlock()

	if len(h.pendingTraffic) == 0 {
		return nil
	}
	records := make([]trafficRecord, 0, len(h.pendingTraffic))
	for _, record := range h.pendingTraffic {
		records = append(records, *record)
	}
	h.pendingTraffic = make(map[trafficKey]*trafficRecord)
	return records
}

func (h *Hub) isServerIP(ip string) bool {
	for _, serverIP := range h.serverIPs {
		if serverIP == ip {
			return true
		}
	}
	return false
}

// isFrontendEvent reports whether the packet belongs to a connection to the
// NetVis web UI. The frontend uses this flag to draw the connection as a
// glowing edge instead of spawning particles.
func (h *Hub) isFrontendEvent(ev capture.Event) bool {
	if h.webPort <= 0 || ev.Proto != "TCP" {
		return false
	}
	if h.isServerIP(ev.SrcIP) && ev.SrcPort == h.webPort {
		return true
	}
	return h.isServerIP(ev.DstIP) && ev.DstPort == h.webPort
}

func (h *Hub) broadcastDirect(msg []byte) {
	// All client-map mutations happen on the hub goroutine, but take the write
	// lock so deletions can never race with a reader or another broadcast.
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- msg:
		default:
			delete(h.clients, c)
			close(c.send)
		}
	}
}

func (h *Hub) BroadcastEvent(ev capture.Event) {
	key := trafficKey{
		SrcIP:    ev.SrcIP,
		DstIP:    ev.DstIP,
		Proto:    ev.Proto,
		Frontend: h.isFrontendEvent(ev),
	}

	h.trafficMu.Lock()
	record := h.pendingTraffic[key]
	if record == nil {
		record = &trafficRecord{
			SrcIP:    ev.SrcIP,
			DstIP:    ev.DstIP,
			Proto:    ev.Proto,
			Frontend: key.Frontend,
		}
		h.pendingTraffic[key] = record
	}
	record.Count++
	record.Bytes += int64(ev.Bytes)
	h.trafficMu.Unlock()
}

// BroadcastHost sends an updated host (e.g. after its hostname or whois
// organization has been resolved) to every connected client.
func (h *Hub) BroadcastHost(host graph.Host) {
	b, err := json.Marshal(map[string]interface{}{
		"type": "host",
		"data": host,
	})
	if err != nil {
		return
	}
	h.broadcast <- b
}
