package server

import (
	"encoding/json"
	"sync"

	"netvis/internal/capture"
	"netvis/internal/graph"
)

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	g          *graph.Graph
	mu         sync.RWMutex
}

func NewHub(g *graph.Graph) *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		g:          g,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = true
			h.mu.Unlock()
			// send snapshot
			snap := h.g.Snapshot()
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
			h.mu.RLock()
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					close(c.send)
					delete(h.clients, c)
				}
			}
			h.mu.RUnlock()
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
