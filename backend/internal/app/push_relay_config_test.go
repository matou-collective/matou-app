package app

import "testing"

// TestPushRelayURLFromConfig covers the embedded-backend fallback that lets the
// Android build learn the push-relay URL from the fetched client config when
// MATOU_PUSH_RELAY_URL can't be set in its (absent) process environment (#329).
func TestPushRelayURLFromConfig(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "top-level push_relay_url is extracted",
			raw:  `{"anysync":{"network":{}},"config_server_url":"https://cfg","push_relay_url":"https://push.awa.matou.nz"}`,
			want: "https://push.awa.matou.nz",
		},
		{
			name: "key absent yields empty (push stays dark)",
			raw:  `{"anysync":{"network":{}},"config_server_url":"https://cfg"}`,
			want: "",
		},
		{
			name: "empty body yields empty",
			raw:  ``,
			want: "",
		},
		{
			name: "unparseable body yields empty",
			raw:  `not json`,
			want: "",
		},
		{
			name: "surrounding whitespace is trimmed",
			raw:  `{"push_relay_url":"  https://push.awa.matou.nz  "}`,
			want: "https://push.awa.matou.nz",
		},
		{
			name: "empty string value yields empty",
			raw:  `{"push_relay_url":""}`,
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pushRelayURLFromConfig([]byte(tt.raw))
			if got != tt.want {
				t.Errorf("pushRelayURLFromConfig(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}
