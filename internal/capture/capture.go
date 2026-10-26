//go:build linux && cgo

package capture

import (
	"fmt"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/google/gopacket/pcap"
)

type Event struct {
	Timestamp time.Time `json:"ts"`
	SrcIP     string    `json:"srcIP"`
	DstIP     string    `json:"dstIP"`
	Proto     string    `json:"proto"`
	Bytes     int       `json:"bytes"`
}

type Handler func(Event)

type Capture struct {
	iface   string
	bpf     string
	handle  *pcap.Handle
	handler Handler
	stop    chan struct{}
}

func New(iface, bpf string, h Handler) (*Capture, error) {
	return &Capture{
		iface:   iface,
		bpf:     bpf,
		handler: h,
		stop:    make(chan struct{}),
	}, nil
}

func (c *Capture) Start() error {
	handle, err := pcap.OpenLive(c.iface, 1600, true, pcap.BlockForever)
	if err != nil {
		return fmt.Errorf("pcap.OpenLive: %w", err)
	}
	c.handle = handle

	if c.bpf != "" {
		if err := handle.SetBPFFilter(c.bpf); err != nil {
			handle.Close()
			return fmt.Errorf("SetBPFFilter: %w", err)
		}
	}

	packetSource := gopacket.NewPacketSource(handle, handle.LinkType())
	go func() {
		for {
			select {
			case <-c.stop:
				return
			default:
			}
			packet, err := packetSource.NextPacket()
			if err != nil {
				continue
			}
			c.processPacket(packet)
		}
	}()
	return nil
}

func (c *Capture) processPacket(pkt gopacket.Packet) {
	var srcIP, dstIP string
	var proto string = "OTHER"

	if net := pkt.NetworkLayer(); net != nil {
		switch v := net.(type) {
		case *layers.IPv4:
			srcIP = v.SrcIP.String()
			dstIP = v.DstIP.String()
		case *layers.IPv6:
			srcIP = v.SrcIP.String()
			dstIP = v.DstIP.String()
		default:
			return
		}
	} else {
		return
	}

	if trans := pkt.TransportLayer(); trans != nil {
		switch trans.(type) {
		case *layers.TCP:
			proto = "TCP"
		case *layers.UDP:
			proto = "UDP"
		default:
			proto = "OTHER"
		}
	} else {
		if pkt.Layer(layers.LayerTypeICMPv4) != nil || pkt.Layer(layers.LayerTypeICMPv6) != nil {
			proto = "ICMP"
		} else {
			proto = "OTHER"
		}
	}

	bytes := len(pkt.Data())
	if bytes == 0 {
		bytes = pkt.Metadata().CaptureLength
	}

	ev := Event{
		Timestamp: time.Now(),
		SrcIP:     srcIP,
		DstIP:     dstIP,
		Proto:     proto,
		Bytes:     bytes,
	}
	if c.handler != nil {
		c.handler(ev)
	}
}

func (c *Capture) Stop() {
	close(c.stop)
	if c.handle != nil {
		c.handle.Close()
	}
}
