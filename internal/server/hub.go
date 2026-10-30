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
}

func NewHub(g *graph.Graph, addr string) *Hub {
	h := &Hub{
		clients:      make(map[*Client]bool),
		broadcast:    make(chan []byte),
		register:     make(chan *Client),
		unregister:   make(chan *Client),
		g:            g,
		serverIPs:    detectServerIPs(),
		webPort:      extractPort(addr),
		pendingBatch: make([][]byte, 0, 32),
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
	if len(h.pendingBatch) == 0 {
		return
	}
	batch := h.pendingBatch
	h.pendingBatch = make([][]byte, 0, 32)

	if len(batch) == 1 {
		h.broadcastDirect(batch[0])
		return
	}

	payload := make([]map[string]json.RawMessage, 0, len(batch))
	for _, b := range batch {
		var m map[string]json.RawMessage
		if json.Unmarshal(b, &m) == nil {
			payload = append(payload, m)
		}
	}
	if len(payload) == 0 {
		return
	}
	wrapped, err := json.Marshal(map[string]interface{}{
		"type": "batch",
		"data": payload,
	})
	if err != nil {
		for _, b := range batch {
			h.broadcastDirect(b)
		}
		return
	}
	h.broadcastDirect(wrapped)
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
	b, err := json.Marshal(map[string]interface{}{
		"type": "packet",
		"data": ev,
	})
	if err != nil {
		return
	}
	h.broadcast <- b
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
