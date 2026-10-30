package server

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"netvis/internal/capture"
	"netvis/internal/graph"
)

type wsMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func nextMessage(t *testing.T, ch <-chan []byte) wsMessage {
	t.Helper()

	select {
	case raw := <-ch:
		var msg wsMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("unmarshal message: %v", err)
		}
		return msg
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for message")
		return wsMessage{}
	}
}

func TestHubSendsSnapshotOnRegister(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4)}
	hub.register <- client

	msg := nextMessage(t, client.send)
	if msg.Type != "snapshot" {
		t.Fatalf("message type = %q, want snapshot", msg.Type)
	}

	var snap graph.Snapshot
	if err := json.Unmarshal(msg.Data, &snap); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if len(snap.Hosts) != 0 || len(snap.Edges) != 0 {
		t.Errorf("empty graph snapshot should have no hosts/edges, got %+v", snap)
	}
	if len(snap.ServerIPs) == 0 {
		t.Error("snapshot should include the server's local addresses")
	}
}

func TestDetectServerIPs(t *testing.T) {
	ips := detectServerIPs()
	if len(ips) == 0 {
		t.Fatal("expected at least one local interface address")
	}
	for _, ip := range ips {
		if net.ParseIP(ip) == nil {
			t.Errorf("detectServerIPs returned invalid address %q", ip)
		}
	}
}

func TestHubAggregatesPackets(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	hub.BroadcastEvent(capture.Event{
		SrcIP: "10.0.0.1",
		DstIP: "8.8.8.8",
		Proto: "UDP",
		Bytes: 42,
	})

	msg := nextMessage(t, client.send)
	if msg.Type != "traffic" {
		t.Fatalf("message type = %q, want traffic", msg.Type)
	}
	var records []trafficRecord
	if err := json.Unmarshal(msg.Data, &records); err != nil {
		t.Fatalf("unmarshal traffic: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("traffic records = %d, want 1: %+v", len(records), records)
	}
	record := records[0]
	if record.SrcIP != "10.0.0.1" || record.DstIP != "8.8.8.8" ||
		record.Proto != "UDP" || record.Count != 1 || record.Bytes != 42 {
		t.Errorf("unexpected traffic record: %+v", record)
	}
}

func TestHubAggregatesRepeatedTraffic(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")

	const events = 100
	for i := 0; i < events; i++ {
		hub.BroadcastEvent(capture.Event{
			SrcIP: "10.0.0.1",
			DstIP: "8.8.8.8",
			Proto: "TCP",
			Bytes: 100,
		})
	}

	records := hub.takeTraffic()
	if len(records) != 1 {
		t.Fatalf("traffic records = %d, want 1: %+v", len(records), records)
	}
	record := records[0]
	if record.Count != events {
		t.Errorf("aggregated count = %d, want %d", record.Count, events)
	}
	if record.Bytes != events*100 {
		t.Errorf("aggregated bytes = %d, want %d", record.Bytes, events*100)
	}
	if record.SrcIP != "10.0.0.1" || record.DstIP != "8.8.8.8" || record.Proto != "TCP" {
		t.Errorf("unexpected traffic record: %+v", record)
	}
}

func TestHubSeparatesFrontendTraffic(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4096)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	if len(hub.serverIPs) == 0 {
		t.Skip("no local interface address available")
	}
	serverIP := hub.serverIPs[0]

	// Same directed edge and protocol, but only one packet belongs to the UI.
	hub.BroadcastEvent(capture.Event{
		SrcIP: serverIP, DstIP: "8.8.8.8", SrcPort: 3993, DstPort: 443, Proto: "TCP", Bytes: 10,
	})
	hub.BroadcastEvent(capture.Event{
		SrcIP: serverIP, DstIP: "8.8.8.8", SrcPort: 55000, DstPort: 443, Proto: "TCP", Bytes: 20,
	})

	records := make([]trafficRecord, 0, 2)
	deadline := time.After(2 * time.Second)
	for len(records) < 2 {
		select {
		case raw := <-client.send:
			var msg wsMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				t.Fatalf("unmarshal message: %v", err)
			}
			if msg.Type != "traffic" {
				continue
			}
			var batch []trafficRecord
			if err := json.Unmarshal(msg.Data, &batch); err != nil {
				t.Fatalf("unmarshal traffic: %v", err)
			}
			records = append(records, batch...)
		case <-deadline:
			t.Fatalf("timed out waiting for traffic records: %+v", records)
		}
	}

	var frontend, regular *trafficRecord
	for i := range records {
		if records[i].Frontend {
			frontend = &records[i]
		} else {
			regular = &records[i]
		}
	}
	if frontend == nil || regular == nil {
		t.Fatalf("expected separate frontend and regular records: %+v", records)
	}
	if frontend.Count != 1 || frontend.Bytes != 10 {
		t.Errorf("unexpected frontend aggregate: %+v", frontend)
	}
	if regular.Count != 1 || regular.Bytes != 20 {
		t.Errorf("unexpected regular aggregate: %+v", regular)
	}
}

func TestHubFlushesSustainedTraffic(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4096)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				hub.BroadcastEvent(capture.Event{
					SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1400,
				})
			}
		}
	}()

	select {
	case <-client.send:
		// A message arrived while traffic was still flowing.
	case <-time.After(250 * time.Millisecond):
		close(stop)
		<-done
		t.Fatal("no batch flushed during sustained traffic; the flush window is being postponed")
	}
	close(stop)
	<-done
}

func TestHubBroadcastsHostUpdates(t *testing.T) {
	g := graph.New()
	g.SetHostUpdateHandler(nil)
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	hub.BroadcastHost(graph.Host{IP: "8.8.8.8", Hostname: "Example Org"})

	msg := nextMessage(t, client.send)
	if msg.Type != "host" {
		t.Fatalf("message type = %q, want host", msg.Type)
	}
	var host graph.Host
	if err := json.Unmarshal(msg.Data, &host); err != nil {
		t.Fatalf("unmarshal host: %v", err)
	}
	if host.IP != "8.8.8.8" || host.Hostname != "Example Org" {
		t.Errorf("unexpected host: %+v", host)
	}
}
