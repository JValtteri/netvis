package server

import (
	"net/http"

	"github.com/gorilla/websocket"
	"netvis/internal/graph"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Server struct {
	g   *graph.Graph
	hub *Hub
}

func New(g *graph.Graph, hub *Hub) *Server {
	return &Server{g: g, hub: hub}
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	// serve static
	fs := http.FileServer(http.Dir("web/static"))
	mux.Handle("/", fs)
	return mux
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &Client{hub: s.hub, conn: conn, send: make(chan []byte, 256)}
	s.hub.register <- client
	go client.writePump()
	go client.readPump()
}
