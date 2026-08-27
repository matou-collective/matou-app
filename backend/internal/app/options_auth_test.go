package app

import (
	"testing"
	"time"
)

func TestOptionsFromEnvSessionTTL(t *testing.T) {
	t.Setenv("MATOU_ENV", "test")
	t.Setenv("MATOU_AUTH_SESSION_TTL", "")
	o, err := OptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if o.SessionTTL != 0 {
		t.Fatalf("unset TTL should be zero (store default), got %v", o.SessionTTL)
	}

	t.Setenv("MATOU_AUTH_SESSION_TTL", "4h")
	o, err = OptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if o.SessionTTL != 4*time.Hour {
		t.Fatalf("expected 4h, got %v", o.SessionTTL)
	}

	t.Setenv("MATOU_AUTH_SESSION_TTL", "soon")
	if _, err := OptionsFromEnv(); err == nil {
		t.Fatal("invalid duration must be an error")
	}

	t.Setenv("MATOU_AUTH_SESSION_TTL", "")
	t.Setenv("MATOU_KERIA_KEYSTATE_URL", "http://localhost:4902/oobi/{aid}")
	o, err = OptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if o.KeyStateURL != "http://localhost:4902/oobi/{aid}" {
		t.Fatalf("KeyStateURL not resolved: %q", o.KeyStateURL)
	}
}
