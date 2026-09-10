//go:build integration

package pairing

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

// configServerURL is the mailbox host under test. Defaults to the test-env
// config server (matou-infrastructure#21 provides /api/pair/*).
func configServerURL() string {
	if u := os.Getenv("MATOU_CONFIG_SERVER_URL"); u != "" {
		return u
	}
	return "http://localhost:4904"
}

// skipIfNoMailbox probes the config server's pairing mailbox and skips when it
// is not reachable, so the tag can run without the infra always present.
func skipIfNoMailbox(t *testing.T, base string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, base+"/api/pair/probe/a?wait=0", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Skipf("config-server mailbox not reachable at %s: %v", base, err)
	}
	_ = resp.Body.Close()
	// 204 (empty) or 404 (expired) both mean the route exists.
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusOK {
		t.Skipf("config-server mailbox route missing at %s (status %d)", base, resp.StatusCode)
	}
}

func runIntegrationFlow(t *testing.T, base string, displayerHolds bool) {
	dispMgr := NewManager(base, WithHTTPClient(&http.Client{Timeout: 30 * time.Second}))
	scanMgr := NewManager(base, WithHTTPClient(&http.Client{Timeout: 30 * time.Second}))

	dispLocal := LocalIdentity{Configured: displayerHolds, DeviceName: "Desktop"}
	scanLocal := LocalIdentity{Configured: !displayerHolds, DeviceName: "Phone"}
	if displayerHolds {
		dispLocal.AID = "AIDdesk"
	} else {
		scanLocal.AID = "AIDphone"
	}

	view, qr, err := dispMgr.CreateDisplayerSession(dispLocal)
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID

	if _, err := scanMgr.Scan(context.Background(), qr, "Phone", scanLocal); err != nil {
		t.Fatal(err)
	}
	waitState(t, dispMgr, id, StateAcked)

	holder := HolderIdentity{Mnemonic: testMnemonic, OrgAID: "ORGaid"}
	receiver := scanMgr
	if displayerHolds {
		holder.AID = "AIDdesk"
		if err := dispMgr.Approve(id, holder); err != nil {
			t.Fatal(err)
		}
	} else {
		holder.AID = "AIDphone"
		receiver = dispMgr
		if err := scanMgr.Approve(id, holder); err != nil {
			t.Fatal(err)
		}
	}

	waitState(t, receiver, id, StateDone)
	payload, err := receiver.TakeIdentity(id, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if payload.Mnemonic != testMnemonic {
		t.Fatalf("mnemonic mismatch: %q", payload.Mnemonic)
	}
}

func TestIntegrationDesktopToPhone(t *testing.T) {
	base := configServerURL()
	skipIfNoMailbox(t, base)
	runIntegrationFlow(t, base, true)
}

func TestIntegrationPhoneToDesktop(t *testing.T) {
	base := configServerURL()
	skipIfNoMailbox(t, base)
	runIntegrationFlow(t, base, false)
}
