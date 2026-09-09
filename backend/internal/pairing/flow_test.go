package pairing

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// Shorten the long-poll window so error-path polls don't stall the suite.
	pollWaitSeconds = 2
	m.Run()
}

// twoManagers builds a displayer and a scanner manager sharing one mailbox.
func twoManagers(t *testing.T, ttl time.Duration) (displayer, scanner *Manager, closeFn func()) {
	t.Helper()
	mem := newMemMailbox(5 * time.Minute)
	srv := mem.server()
	opts := []ManagerOption{WithHTTPClient(srv.Client())}
	if ttl > 0 {
		opts = append(opts, WithTTL(ttl))
	}
	displayer = NewManager(srv.URL, opts...)
	scanner = NewManager(srv.URL, opts...)
	return displayer, scanner, srv.Close
}

// waitState polls until the manager reports state, or fails after timeout.
func waitState(t *testing.T, m *Manager, id string, want State) SessionView {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		v, err := m.View(id)
		if err == nil && v.State == want {
			return v
		}
		time.Sleep(5 * time.Millisecond)
	}
	v, err := m.View(id)
	t.Fatalf("timed out waiting for state %s; last view=%+v err=%v", want, v, err)
	return SessionView{}
}

const testMnemonic = "zztest1 zztest2 zztest3 zztest4 zztest5 zztest6 zztest7 zztest8 zztest9 zztest10 zztest11 zztest12"

func TestFlowDesktopToPhone(t *testing.T) {
	dispMgr, scanMgr, done := twoManagers(t, 0)
	defer done()

	displayerLocal := LocalIdentity{Configured: true, AID: "AIDdesk", DeviceName: "Desktop"}
	scannerLocal := LocalIdentity{Configured: false, DeviceName: "Phone"}

	view, qr, err := dispMgr.CreateDisplayerSession(displayerLocal)
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID

	sv, err := scanMgr.Scan(context.Background(), qr, "Phone", scannerLocal)
	if err != nil {
		t.Fatal(err)
	}
	if sv.Outcome != OutcomeDesktopToPhone {
		t.Fatalf("scanner outcome = %s, want desktop-to-phone", sv.Outcome)
	}
	if sv.Code == "" {
		t.Fatal("scanner code is empty")
	}
	if sv.PeerDeviceName != "Desktop" {
		t.Fatalf("scanner peer = %q, want Desktop", sv.PeerDeviceName)
	}

	da := waitState(t, dispMgr, id, StateAcked)
	if da.Outcome != OutcomeDesktopToPhone || da.PeerDeviceName != "Phone" {
		t.Fatalf("displayer view = %+v", da)
	}
	if da.Code != sv.Code {
		t.Fatalf("codes differ: displayer %s vs scanner %s", da.Code, sv.Code)
	}

	// Identity-present guard: a receiver backend that already holds an identity
	// refuses (spec §3.3).
	if _, err := scanMgr.TakeIdentity(id, true, "AIDphone"); err == nil {
		t.Fatal("expected identity-present error")
	} else {
		var present *IdentityPresentError
		if !errors.As(err, &present) || present.AID != "AIDphone" {
			t.Fatalf("expected IdentityPresentError, got %v", err)
		}
	}

	// Holder approves; identity flows to the receiver.
	holder := HolderIdentity{Mnemonic: testMnemonic, AID: "AIDdesk", OrgAID: "ORGaid", ConfigServerURL: "http://cs"}
	if err := dispMgr.Approve(id, holder); err != nil {
		t.Fatal(err)
	}

	waitState(t, scanMgr, id, StateDone)
	waitState(t, dispMgr, id, StateDone)

	// Redaction: the receiver session holds the mnemonic but never prints it.
	if dump := fmt.Sprintf("%+v", scanMgr.sess); strings.Contains(dump, "zztest1") {
		t.Fatalf("session dump leaked the mnemonic: %s", dump)
	}

	payload, err := scanMgr.TakeIdentity(id, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if payload.Mnemonic != testMnemonic || payload.AID != "AIDdesk" || payload.OrgAID != "ORGaid" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	// Single read: the second call finds nothing.
	if _, err := scanMgr.TakeIdentity(id, false, ""); !errors.Is(err, ErrIdentityUnavailable) {
		t.Fatalf("expected ErrIdentityUnavailable on second read, got %v", err)
	}
}

func TestFlowPhoneToDesktop(t *testing.T) {
	dispMgr, scanMgr, done := twoManagers(t, 0)
	defer done()

	displayerLocal := LocalIdentity{Configured: false, DeviceName: "Desktop"}
	scannerLocal := LocalIdentity{Configured: true, AID: "AIDphone", DeviceName: "Phone"}

	view, qr, err := dispMgr.CreateDisplayerSession(displayerLocal)
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID

	sv, err := scanMgr.Scan(context.Background(), qr, "Phone", scannerLocal)
	if err != nil {
		t.Fatal(err)
	}
	if sv.Outcome != OutcomePhoneToDesktop {
		t.Fatalf("outcome = %s, want phone-to-desktop", sv.Outcome)
	}

	waitState(t, dispMgr, id, StateAcked)

	// The scanner (phone) is the holder here; it approves.
	holder := HolderIdentity{Mnemonic: testMnemonic, AID: "AIDphone", OrgAID: "ORGaid"}
	if err := scanMgr.Approve(id, holder); err != nil {
		t.Fatal(err)
	}

	waitState(t, dispMgr, id, StateDone)
	waitState(t, scanMgr, id, StateDone)

	payload, err := dispMgr.TakeIdentity(id, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if payload.Mnemonic != testMnemonic || payload.AID != "AIDphone" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestFlowNonProceedingOutcomes(t *testing.T) {
	cases := []struct {
		name string
		disp LocalIdentity
		scan LocalIdentity
		want Outcome
	}{
		{"neither", LocalIdentity{Configured: false}, LocalIdentity{Configured: false}, OutcomeNeither},
		{"already-linked", LocalIdentity{Configured: true, AID: "AIDX"}, LocalIdentity{Configured: true, AID: "AIDX"}, OutcomeAlreadyLinked},
		{"conflict", LocalIdentity{Configured: true, AID: "AIDX"}, LocalIdentity{Configured: true, AID: "AIDY"}, OutcomeConflict},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dispMgr, scanMgr, done := twoManagers(t, 0)
			defer done()

			c.disp.DeviceName = "Desktop"
			c.scan.DeviceName = "Phone"
			view, qr, err := dispMgr.CreateDisplayerSession(c.disp)
			if err != nil {
				t.Fatal(err)
			}
			sv, err := scanMgr.Scan(context.Background(), qr, "Phone", c.scan)
			if err != nil {
				t.Fatal(err)
			}
			if sv.Outcome != c.want {
				t.Fatalf("scanner outcome = %s, want %s", sv.Outcome, c.want)
			}
			da := waitState(t, dispMgr, view.SessionID, StateAcked)
			if da.Outcome != c.want {
				t.Fatalf("displayer outcome = %s, want %s", da.Outcome, c.want)
			}
		})
	}
}

func TestReplayedHelloAfterAckRejected(t *testing.T) {
	dispMgr, scanMgr, done := twoManagers(t, 0)
	defer done()

	view, qr, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk", DeviceName: "Desktop"})
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID
	if _, err := scanMgr.Scan(context.Background(), qr, "Phone", LocalIdentity{Configured: false}); err != nil {
		t.Fatal(err)
	}
	waitState(t, dispMgr, id, StateAcked)

	// The displayer is the holder (desktop-to-phone) and is blocked on Approve —
	// it no longer reads slot a. Inject a second hello directly onto slot a.
	parsed, _ := parseQRPayload(qr)
	raw := newMailbox(parsed.configServerURL, dispMgr.httpClient)
	if err := raw.put(context.Background(), id, slotA, []byte("second-hello-garbage")); err != nil {
		t.Fatal(err)
	}

	// State must not regress out of acked, and no second ack is emitted (the
	// scanner already consumed the first; slot b stays empty).
	time.Sleep(60 * time.Millisecond)
	v, _ := dispMgr.View(id)
	if v.State != StateAcked {
		t.Fatalf("displayer state regressed to %s after a replayed hello", v.State)
	}
	blob, err := raw.get(context.Background(), id, slotB, 1)
	if err != nil {
		t.Fatal(err)
	}
	if blob != nil {
		t.Fatalf("a second ack was emitted for a replayed hello: %q", blob)
	}
}

func TestExpiredSession(t *testing.T) {
	dispMgr, _, done := twoManagers(t, 40*time.Millisecond)
	defer done()

	view, _, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk", DeviceName: "Desktop"})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if _, err := dispMgr.View(view.SessionID); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
	// TakeIdentity on an expired session is also 410.
	if _, err := dispMgr.TakeIdentity(view.SessionID, false, ""); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired from TakeIdentity, got %v", err)
	}
}

func TestSecondSessionCancelsFirst(t *testing.T) {
	dispMgr, _, done := twoManagers(t, 0)
	defer done()

	first, _, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk"})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk"})
	if err != nil {
		t.Fatal(err)
	}
	if first.SessionID == second.SessionID {
		t.Fatal("second session reused the first id")
	}
	// The first session is no longer the current one.
	if _, err := dispMgr.View(first.SessionID); !errors.Is(err, ErrNoSession) {
		t.Fatalf("expected ErrNoSession for the cancelled first session, got %v", err)
	}
}

func TestSessionRedaction(t *testing.T) {
	s := &session{
		id:         "abc",
		kind:       kindScanner,
		state:      StateAcked,
		pairSecret: []byte("PAIRSECRETXYZ"),
		k:          []byte("SESSIONKEY0123456789ABCDEF012345"),
		received:   &identityMsg{Mnemonic: "alpha bravo charlie", AID: "AIDX"},
		toSend:     &identityMsg{Mnemonic: "delta echo foxtrot", AID: "AIDY"},
	}
	dump := fmt.Sprintf("%v %+v %#v %s", s, s, s, s)
	for _, leak := range []string{"PAIRSECRETXYZ", "SESSIONKEY", "alpha bravo charlie", "delta echo foxtrot"} {
		if strings.Contains(dump, leak) {
			t.Fatalf("session leaked %q: %s", leak, dump)
		}
	}

	m := identityMsg{Mnemonic: "golf hotel india", AID: "AIDZ"}
	if strings.Contains(m.String(), "golf") || strings.Contains(m.GoString(), "golf") {
		t.Fatalf("identityMsg leaked its mnemonic")
	}
}
