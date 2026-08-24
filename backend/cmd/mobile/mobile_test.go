package mobile

import "testing"

// TestStopWithoutStartIsNoop confirms Stop is safe to call when nothing is
// running: it returns nil rather than panicking on the nil App, so the host can
// call Stop unconditionally.
func TestStopWithoutStartIsNoop(t *testing.T) {
	// Guard against leakage from a prior test that left a running instance.
	if running != nil {
		t.Fatalf("precondition: running is %v, want nil", running)
	}
	if err := Stop(); err != nil {
		t.Fatalf("Stop with no running backend returned error: %v", err)
	}
	if running != nil {
		t.Fatalf("running is %v after Stop, want nil", running)
	}
}

// TestStartRejectsEmptyArgs confirms each required argument is validated before
// any backend wiring happens: Start returns port 0 and an error, and starts
// nothing (running stays nil). This runs without live infrastructure because
// validation short-circuits before app.Start.
func TestStartRejectsEmptyArgs(t *testing.T) {
	cases := []struct {
		name                               string
		dataDir, configServerURL, apiToken string
	}{
		{"empty dataDir", "", "http://localhost:3904", "tok"},
		{"empty configServerURL", "/tmp/data", "", "tok"},
		{"empty apiToken", "/tmp/data", "http://localhost:3904", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			port, err := Start(tc.dataDir, tc.configServerURL, tc.apiToken)
			if err == nil {
				t.Fatalf("Start(%q, %q, %q) = %d, nil; want error",
					tc.dataDir, tc.configServerURL, tc.apiToken, port)
			}
			if port != 0 {
				t.Fatalf("Start returned port %d on error, want 0", port)
			}
			if running != nil {
				t.Fatalf("running is %v after rejected Start, want nil", running)
			}
		})
	}
}
