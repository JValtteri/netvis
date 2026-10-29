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
		if org != "" || country != "" {
			return org, country
		}
	}
	return parseWhoisOrg(ianaResp), parseWhoisCountry(ianaResp)
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
	if _, err := fmt.Fprintf(conn, "%s\r\n", query); err != nil {
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
		best = value
		bestPriority = priority
	}

	return best
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
	switch strings.ToLower(value) {
	case "not available", "n/a", "na", "none", "null", "redacted",
		"not disclosed", "unknown":
		return false
	}
	return true
}
