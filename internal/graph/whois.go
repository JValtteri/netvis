package graph

import (
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const maxWhoisResponse = 1 << 20 // 1 MiB

// lookupWhoisInfo resolves the organization and country responsible for an
// external IP by querying the IANA whois referral and then the authoritative
// RIR whois server.
func lookupWhoisInfo(ip string) (org, country string) {
	ianaResp := whoisQuery("whois.iana.org", ip, 3*time.Second)
	if server := parseWhoisReferral(ianaResp); server != "" {
		resp := whoisQuery(server, ip, 5*time.Second)
		org = parseWhoisOrg(resp)
		country = parseWhoisCountry(resp)
		if isUsefulOrg(org) && org != "" {
			return org, country
		}
		// If the referred server only returned a placeholder (e.g. RIPE saying
		// the block isn't managed by RIPE NCC), try common RIRs directly.
		for _, fallback := range []string{"whois.arin.net", "whois.apnic.net", "whois.lacnic.net", "whois.afrinic.net"} {
			if strings.EqualFold(fallback, server) {
				continue
			}
			fresp := whoisQuery(fallback, ip, 5*time.Second)
			forg := parseWhoisOrg(fresp)
			if isUsefulOrg(forg) && forg != "" {
				fc := parseWhoisCountry(fresp)
				if fc == "" {
					fc = country
				}
				return forg, fc
			}
		}
		if country != "" {
			return "", country
		}
		return "", ""
	}
	org = parseWhoisOrg(ianaResp)
	if !isUsefulOrg(org) {
		org = ""
	}
	return org, parseWhoisCountry(ianaResp)
}

func isUsefulOrg(org string) bool {
	if org == "" {
		return false
	}
	l := strings.ToLower(org)
	if strings.Contains(l, "not managed by") || strings.Contains(l, "non-ripe-ncc-managed") || strings.Contains(l, "address block not managed") {
		return false
	}
	if strings.Contains(l, "early registration") {
		return false
	}
	if strings.Contains(l, "internet assigned numbers authority") {
		return false
	}
	if strings.Contains(l, "administered by") && (strings.Contains(l, "ripe") || strings.Contains(l, "arin") || strings.Contains(l, "apnic") || strings.Contains(l, "lacnic") || strings.Contains(l, "afrinic")) {
		return false
	}
	if l == "iana" {
		return false
	}
	return true
}

func whoisQuery(server, query string, timeout time.Duration) string {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(server, "43"), timeout)
	if err != nil {
		return ""
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return ""
	}

	// Try more specific queries for ARIN to get the correct assignment
	q := query
	if strings.Contains(server, "arin.net") {
		// Try to get network block details with explicit flags
		if _, err := fmt.Fprintf(conn, "n + %s\r\n", query); err != nil {
			conn.Close()
			return ""
		}
		data, err := io.ReadAll(io.LimitReader(conn, maxWhoisResponse))
		if err != nil && len(data) == 0 {
			conn.Close()
			return ""
		}
		// If still ambiguous, also try without flags as fallback
		if strings.Contains(string(data), "Query terms are ambiguous") {
			conn.Close()
			// try again with just IP
			conn2, err2 := net.DialTimeout("tcp", net.JoinHostPort(server, "43"), timeout)
			if err2 != nil {
				return ""
			}
			defer conn2.Close()
			if err2 := conn2.SetDeadline(time.Now().Add(timeout)); err2 != nil {
				return ""
			}
			if _, err2 := fmt.Fprintf(conn2, "%s\r\n", query); err2 != nil {
				return ""
			}
			data2, err2 := io.ReadAll(io.LimitReader(conn2, maxWhoisResponse))
			if err2 != nil && len(data2) == 0 {
				return ""
			}
			return string(data2)
		}
		return string(data)
	}

	if _, err := fmt.Fprintf(conn, "%s\r\n", q); err != nil {
		return ""
	}

	data, err := io.ReadAll(io.LimitReader(conn, maxWhoisResponse))
	if err != nil && len(data) == 0 {
		return ""
	}
	return string(data)
}

func parseWhoisReferral(resp string) string {
	for _, line := range strings.Split(resp, "\n") {
		key, value := splitWhoisLine(line)
		switch strings.ToLower(key) {
		case "refer":
			return normalizeWhoisServer(value)
		case "referralserver":
			return normalizeWhoisServer(value)
		}
	}
	return ""
}

func normalizeWhoisServer(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "whois://")
	value = strings.TrimPrefix(value, "rwhois://")
	if i := strings.IndexAny(value, ":/"); i >= 0 {
		value = value[:i]
	}
	return strings.TrimSpace(value)
}

var whoisOrgKeys = map[string]int{
	"org-name":     0,
	"orgname":      0,
	"organization": 1,
	"organisation": 1,
	"owner":        2,
	"org":          3,
	"descr":        4,
	"netname":      5,
}

func parseWhoisOrg(resp string) string {
	best := ""
	bestPriority := len(whoisOrgKeys)
	bestPrefix := -100

	blocks := splitWhoisBlocks(resp)
	if len(blocks) == 0 {
		blocks = []string{resp}
	}

	for _, block := range blocks {
		blockBest := ""
		blockBestPriority := len(whoisOrgKeys)
		for _, line := range strings.Split(block, "\n") {
			key, value := splitWhoisLine(line)
			priority, ok := whoisOrgKeys[strings.ToLower(key)]
			if !ok || priority >= blockBestPriority {
				continue
			}
			value = strings.TrimSpace(value)
			if !usefulWhoisValue(value) {
				continue
			}
			if !isUsefulOrg(value) {
				continue
			}
			blockBest = value
			blockBestPriority = priority
		}
		if blockBest == "" {
			continue
		}
		prefix := blockPrefixLen(block)
		if prefix < 0 {
			prefix = 0
		}
		if prefix > bestPrefix {
			best = blockBest
			bestPrefix = prefix
			bestPriority = blockBestPriority
			continue
		}
		if prefix == bestPrefix && blockBestPriority < bestPriority {
			best = blockBest
			bestPriority = blockBestPriority
		}
	}

	if best != "" {
		return best
	}

	// Fallback to global scan if block parsing didn't find anything
	for _, line := range strings.Split(resp, "\n") {
		key, value := splitWhoisLine(line)
		priority, ok := whoisOrgKeys[strings.ToLower(key)]
		if !ok || priority >= bestPriority {
			continue
		}
		value = strings.TrimSpace(value)
		if !usefulWhoisValue(value) {
			continue
		}
		if !isUsefulOrg(value) {
			continue
		}
		best = value
		bestPriority = priority
	}

	return best
}

func splitWhoisBlocks(resp string) []string {
	var blocks []string
	var current []string
	for _, line := range strings.Split(resp, "\n") {
		trimmed := strings.TrimSpace(line)
		l := strings.ToLower(trimmed)
		if strings.HasPrefix(l, "# start") || strings.HasPrefix(l, "% start") {
			if len(current) > 0 {
				blocks = append(blocks, strings.Join(current, "\n"))
				current = nil
			}
			continue
		}
		if strings.HasPrefix(l, "# end") || strings.HasPrefix(l, "% end") {
			if len(current) > 0 {
				blocks = append(blocks, strings.Join(current, "\n"))
				current = nil
			}
			continue
		}
		if isBlockStart(trimmed) && len(current) > 0 && hasBlockContent(current) {
			blocks = append(blocks, strings.Join(current, "\n"))
			current = nil
		}
		current = append(current, line)
	}
	if len(current) > 0 {
		blocks = append(blocks, strings.Join(current, "\n"))
	}
	return blocks
}

func isBlockStart(line string) bool {
	if line == "" {
		return false
	}
	l := strings.ToLower(line)
	if strings.HasPrefix(l, "inetnum:") || strings.HasPrefix(l, "netrange:") {
		return true
	}
	if strings.HasPrefix(l, "route:") || strings.HasPrefix(l, "route6:") {
		return true
	}
	if strings.HasPrefix(l, "aut-num:") {
		return true
	}
	return false
}

func hasBlockContent(lines []string) bool {
	for _, l := range lines {
		if strings.Contains(l, ":") {
			return true
		}
	}
	return false
}

func blockPrefixLen(block string) int {
	for _, line := range strings.Split(block, "\n") {
		key, value := splitWhoisLine(line)
		if key == "" {
			continue
		}
		lk := strings.ToLower(key)
		if lk == "netrange" {
			// NetRange:       136.244.64.0 - 136.244.127.255
			if _, _, prefix, ok := parseNetRange(value); ok {
				return prefix
			}
		}
		if lk == "inetnum" {
			if _, _, prefix, ok := parseInetnum(value); ok {
				return prefix
			}
		}
		if lk == "cidr" {
			if prefix, ok := parseCIDRPrefix(value); ok {
				return prefix
			}
		}
	}
	return -1
}

func parseCIDRPrefix(s string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(s), ",")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if strings.Contains(p, "/") {
			_, ipnet, err := net.ParseCIDR(p)
			if err == nil {
				ones, _ := ipnet.Mask.Size()
				return ones, true
			}
		}
	}
	return 0, false
}

func parseInetnum(s string) (net.IP, net.IP, int, bool) {
	// format: A.B.C.D - E.F.G.H
	parts := strings.Split(s, "-")
	if len(parts) != 2 {
		return nil, nil, 0, false
	}
	start := net.ParseIP(strings.TrimSpace(parts[0]))
	end := net.ParseIP(strings.TrimSpace(parts[1]))
	if start == nil || end == nil {
		return nil, nil, 0, false
	}
	start4 := start.To4()
	end4 := end.To4()
	if start4 != nil && end4 != nil {
		prefix := rangeToPrefix(start4, end4)
		return start4, end4, prefix, prefix >= 0
	}
	return start, end, 0, false
}

func parseNetRange(s string) (net.IP, net.IP, int, bool) {
	// same format as inetnum
	return parseInetnum(s)
}

func rangeToPrefix(start, end net.IP) int {
	// compute smallest prefix covering range [start,end] - approximate by trying
	// but easier: count bits where different? or just compute based on alignment
	// for whois ranges, often aligned; compute by finding common prefix
	s := binaryToInt(start)
	e := binaryToInt(end)
	if e < s {
		return -1
	}
	// find highest differing bit from left? rough: (32 - floor(log2(e-s+1))) gives size
	size := e - s + 1
	if size <= 0 {
		return -1
	}
	// find prefix: for aligned ranges, we can scan down from 32
	for prefix := 0; prefix <= 32; prefix++ {
		mask := prefixMask(prefix)
		if (s &^ mask) == 0 && ((e & mask) == mask) {
			// check if range fits exactly in this prefix block? sometimes ranges aren't exactly aligned
			// but usually they are; also try to be specific
		}
	}
	// simpler: compute based on popcount of (e^s) or just use 32 - bits for size
	// find smallest prefix (largest number) such that block of that prefix covers
	for prefix := 32; prefix >= 0; prefix-- {
		var blockSize uint32
		if prefix == 32 {
			blockSize = 1
		} else {
			shift := 32 - prefix
			if shift >= 32 {
				blockSize = 0
			} else {
				blockSize = uint32(1) << uint(shift)
			}
		}
		if blockSize == 0 {
			continue
		}
		if s%blockSize == 0 && (s+blockSize-1) == e {
			return prefix
		}
	}
	// fallback: estimate
	// count leading zeros in (size-1) flipped? not straightforward in uint32
	p := 32
	temp := size - 1
	for temp > 0 && p >= 0 {
		temp >>= 1
		p--
	}
	if p < 0 {
		p = 0
	}
	return p
}

func binaryToInt(ip net.IP) uint32 {
	ip = ip.To4()
	if ip == nil {
		return 0
	}
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}

func prefixMask(prefix int) uint32 {
	if prefix <= 0 {
		return 0
	}
	if prefix >= 32 {
		return 0xffffffff
	}
	return ^uint32((1 << uint(32-prefix)) - 1)
}

var whoisCountryKeys = map[string]bool{
	"country":      true,
	"country-code": true,
	"country code": true,
	"countrycode":  true,
}

func parseWhoisCountry(resp string) string {
	for _, line := range strings.Split(resp, "\n") {
		key, value := splitWhoisLine(line)
		if !whoisCountryKeys[strings.ToLower(key)] {
			continue
		}
		value = strings.TrimSpace(value)
		if !usefulWhoisValue(value) {
			continue
		}
		if len(value) == 2 {
			return strings.ToUpper(value)
		}
		return value
	}
	return ""
}

func splitWhoisLine(line string) (string, string) {
	line = strings.TrimSpace(line)
	i := strings.Index(line, ":")
	if i <= 0 {
		return "", ""
	}
	return strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+1:])
}

func usefulWhoisValue(value string) bool {
	if value == "" {
		return false
	}
	l := strings.ToLower(value)
	switch l {
	case "not available", "n/a", "na", "none", "null", "redacted",
		"not disclosed", "unknown":
		return false
	}
	if strings.Contains(l, "not managed by") {
		return false
	}
	if strings.Contains(l, "non-ripe-ncc-managed") {
		return false
	}
	if strings.Contains(l, "address block not managed") {
		return false
	}
	return true
}
