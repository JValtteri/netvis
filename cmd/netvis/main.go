package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"netvis/internal/capture"
	"netvis/internal/graph"
	"netvis/internal/server"
)

func main() {
	iface := flag.String("iface", "", "Network interface to capture on (e.g. eth0, wlan0, any)")
	bpf := flag.String("filter", "", "BPF filter (optional)")
	addr := flag.String("addr", ":3993", "HTTP listen address")
	hostTTL := flag.Duration("host-ttl", 0, "Remove hosts and edges idle longer than this duration (0 keeps everything, e.g. 24h)")
	maxHosts := flag.Int("max-hosts", 0, "Maximum hosts to retain, evicting least recently active first (0 = unlimited)")
	flag.Parse()

	if *iface == "" {
		log.Fatal("must specify -iface (e.g. eth0, wlan0, any)")
	}
	if *hostTTL < 0 {
		log.Fatal("-host-ttl must not be negative")
	}
	if *maxHosts < 0 {
		log.Fatal("-max-hosts must not be negative")
	}

	g := graph.New()
	g.SetRetention(*hostTTL, *maxHosts)
	stopRetention := g.StartRetention(30 * time.Second)
	defer stopRetention()

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
