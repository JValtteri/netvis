package graph

import "testing"

func TestParseWhoisReferral(t *testing.T) {
	cases := []struct {
		name string
		resp string
		want string
	}{
		{
			name: "refer key",
			resp: "% IANA WHOIS server\n\nrefer:        whois.arin.net\n",
			want: "whois.arin.net",
		},
		{
			name: "referral server with scheme",
			resp: "ReferralServer: whois://whois.ripe.net:43\n",
			want: "whois.ripe.net",
		},
		{
			name: "rwhois referral",
			resp: "ReferralServer: rwhois://rwhois.example.com:4321\n",
			want: "rwhois.example.com",
		},
		{
			name: "no referral",
			resp: "inetnum: 1.2.3.0 - 1.2.3.255\n",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseWhoisReferral(tc.resp); got != tc.want {
				t.Errorf("parseWhoisReferral() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeWhoisServer(t *testing.T) {
	cases := map[string]string{
		" whois.arin.net ":                 "whois.arin.net",
		"whois://whois.ripe.net:43":        "whois.ripe.net",
		"rwhois://rwhois.example.com:4321": "rwhois.example.com",
		"whois.apnic.net":                  "whois.apnic.net",
	}

	for input, want := range cases {
		if got := normalizeWhoisServer(input); got != want {
			t.Errorf("normalizeWhoisServer(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseWhoisOrg(t *testing.T) {
	cases := []struct {
		name string
		resp string
		want string
	}{
		{
			name: "orgname preferred over descr",
			resp: "NetName: EXAMPLE\nOrgName: Example Org\nOrganization: Other Org\nDescr: Some description\n",
			want: "Example Org",
		},
		{
			name: "ripe org-name",
			resp: "netname: RIPE-NCC\norg-name: RIPE NCC\n",
			want: "RIPE NCC",
		},
		{
			name: "lacnic owner",
			resp: "owner: Some Owner\n",
			want: "Some Owner",
		},
		{
			name: "fallback to netname",
			resp: "OrgName: Not Available\ndescr: Not Disclosed\nnetname: FALLBACK-NET\n",
			want: "FALLBACK-NET",
		},
		{
			name: "no useful value",
			resp: "OrgName: N/A\nOrganization:\n",
			want: "",
		},
		{
			name: "empty response",
			resp: "",
			want: "",
		},
		{
			name: "arin cloudflare",
			resp: "NetRange:       104.16.0.0 - 104.31.255.255\nCIDR:           104.16.0.0/12\nNetName:        CLOUDFLARENET\nOrganization:   Cloudflare, Inc. (CLOUD14)\n\nOrgName:        Cloudflare, Inc.\nCountry:        US\n",
			want: "Cloudflare, Inc.",
		},
		{
			name: "filters ripe placeholder",
			resp: "inetnum:        151.101.0.0 - 151.105.255.255\nnetname:        NON-RIPE-NCC-MANAGED-ADDRESS-BLOCK\ndescr:          IPv4 address block not managed by the RIPE NCC\n",
			want: "",
		},
		{
			name: "filters early registration",
			resp: "NetRange:       136.0.0.0 - 136.255.255.255\nOrganization:   Early registration addresses\n",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseWhoisOrg(tc.resp); got != tc.want {
				t.Errorf("parseWhoisOrg() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseWhoisCountry(t *testing.T) {
	cases := []struct {
		name string
		resp string
		want string
	}{
		{
			name: "ripe country code",
			resp: "netname: RIPE-NCC\ncountry: nl\n",
			want: "NL",
		},
		{
			name: "arin country key",
			resp: "OrgName: Example Org\nCountry: US\n",
			want: "US",
		},
		{
			name: "country code key",
			resp: "Country Code: DE\n",
			want: "DE",
		},
		{
			name: "full country name",
			resp: "country: Finland\n",
			want: "Finland",
		},
		{
			name: "skip unavailable value",
			resp: "country: N/A\n",
			want: "",
		},
		{
			name: "missing country",
			resp: "netname: EXAMPLE\n",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseWhoisCountry(tc.resp); got != tc.want {
				t.Errorf("parseWhoisCountry() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSplitWhoisLine(t *testing.T) {
	cases := []struct {
		line    string
		wantKey string
		wantVal string
	}{
		{"OrgName: Example Org", "OrgName", "Example Org"},
		{"  netname: EXAMPLE  ", "netname", "EXAMPLE"},
		{"descr: value: with colon", "descr", "value: with colon"},
		{"no colon", "", ""},
		{": leading colon", "", ""},
	}

	for _, tc := range cases {
		key, value := splitWhoisLine(tc.line)
		if key != tc.wantKey || value != tc.wantVal {
			t.Errorf("splitWhoisLine(%q) = (%q, %q), want (%q, %q)",
				tc.line, key, value, tc.wantKey, tc.wantVal)
		}
	}
}

func TestUsefulWhoisValue(t *testing.T) {
	useful := []string{"Google LLC", "Example", "netname"}
	for _, v := range useful {
		if !usefulWhoisValue(v) {
			t.Errorf("usefulWhoisValue(%q) = false, want true", v)
		}
	}

	notUseful := []string{"", "N/A", "Not Available", "Not Disclosed", "redacted", "unknown"}
	for _, v := range notUseful {
		if usefulWhoisValue(v) {
			t.Errorf("usefulWhoisValue(%q) = true, want false", v)
		}
	}
}

func TestParseWhoisOrgBlocksPreferSpecific(t *testing.T) {
	resp := "NetRange:       23.32.0.0 - 23.67.255.255\nCIDR:           23.32.0.0/11\nNetName:        AKAMAI\nOrganization:   Akamai Technologies, Inc. (AKAMAI)\n\nOrgName:        Akamai Technologies, Inc.\n\nNetRange:       23.36.0.0 - 23.36.255.255\nNetName:        SOME\nOrganization:   Some Other Org\n\nOrgName:        Some Other Org\n"
	if got := parseWhoisOrg(resp); got != "Some Other Org" {
		t.Fatalf("got %q", got)
	}
}

func TestParseWhoisOrgNoCrashOnMalformedRange(t *testing.T) {
	resp := "NetRange: bad\nOrganization: Example Corp\n"
	if got := parseWhoisOrg(resp); got != "Example Corp" {
		t.Fatalf("got %q", got)
	}
}
