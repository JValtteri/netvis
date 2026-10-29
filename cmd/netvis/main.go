package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"netvis/internal/capture"
	"netvis/internal/graph"
	"netvis/internal/server"
)

func main() {
	iface := flag.String("iface", "", "Network interface to capture on (e.g. eth0, wlan0)")
	bpf := flag.String("filter", "", "BPF filter (optional)")
	addr := flag.String("addr", ":3993", "HTTP listen address")
	flag.Parse()

	if *iface == "" {
		log.Fatal("must specify -iface")
	}

	g := graph.New()
	hub := server.NewHub(g, *addr)
	g.SetHostUpdateHandler(hub.BroadcastHost)
	go hub.Run()

	// Start HTTP server
	s := server.New(g, hub)
	go func() {
		log.Printf("serving on http://localhost%s", *addr)
		if err := http.ListenAndServe(*addr, s.Router()); err != nil {
			log.Fatal(err)
		}
	}()

	// Start capture
	c, err := capture.New(*iface, *bpf, func(ev capture.Event) {
		hub.BroadcastEvent(ev)
		g.Apply(ev)
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := c.Start(); err != nil {
		log.Fatal(err)
	}

	// Wait for signal
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Println("shutting down")
	c.Stop()
}
