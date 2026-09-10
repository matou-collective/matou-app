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

// TestGarbageHelloFailsClosed: a mailbox observer (or a stray client) writes an
// unauthenticated blob into slot a before the real scanner does. The displayer
// must not sit in a live-looking state with its driver gone: the session lands
// in the terminal failed state with an error, its secrets are wiped, and
// Approve / TakeIdentity are refused.
func TestGarbageHelloFailsClosed(t *testing.T) {
	dispMgr, _, done := twoManagers(t, 0)
	defer done()

	view, qr, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk", DeviceName: "Desktop"})
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID
	parsed, _ := parseQRPayload(qr)
	raw := newMailbox(parsed.configServerURL, dispMgr.httpClient)
	garbage := make([]byte, 32+nonceSize+16)
	if err := raw.put(context.Background(), id, slotA, garbage); err != nil {
		t.Fatal(err)
	}

	v := waitState(t, dispMgr, id, StateFailed)
	if v.Error == "" {
		t.Fatal("failed session carries no error message")
	}
	if !dispMgr.sess.wiped() {
		t.Fatal("failed session still holds secrets")
	}
	if err := dispMgr.Approve(id, HolderIdentity{Mnemonic: testMnemonic, AID: "AIDdesk"}); !errors.Is(err, ErrWrongState) {
		t.Fatalf("Approve on a failed session = %v, want ErrWrongState", err)
	}
	if _, err := dispMgr.TakeIdentity(id, false, ""); !errors.Is(err, ErrIdentityUnavailable) {
		t.Fatalf("TakeIdentity on a failed session = %v, want ErrIdentityUnavailable", err)
	}
	// Failed is terminal: a late expiry timer must not relabel it.
	dispMgr.sess.markExpired()
	if v, _ := dispMgr.View(id); v.State != StateFailed {
		t.Fatalf("state left failed: %s", v.State)
	}
}

// TestReplayedHelloOnReceiverDisplayerFailsClosed: in the phone-to-desktop
// direction the displayer keeps reading slot a for the identity. A replayed
// hello (or any blob under the wrong key) fails the AEAD tag and ends the
// session as failed — it never becomes an identity.
func TestReplayedHelloOnReceiverDisplayerFailsClosed(t *testing.T) {
	dispMgr, scanMgr, done := twoManagers(t, 0)
	defer done()

	view, qr, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: false, DeviceName: "Desktop"})
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID
	if _, err := scanMgr.Scan(context.Background(), qr, "Phone", LocalIdentity{Configured: true, AID: "AIDphone"}); err != nil {
		t.Fatal(err)
	}
	waitState(t, dispMgr, id, StateAcked)

	// Rebuild the scanner's hello blob (same key, fresh nonce) and replay it.
	scanMgr.sess.mu.Lock()
	k := append([]byte{}, scanMgr.sess.k...)
	pub := scanMgr.sess.eph.PublicKey().Bytes()
	scanMgr.sess.mu.Unlock()
	sealed, _ := seal(k, []byte(`{"role":"holder","aid":"AIDphone","deviceName":"Phone"}`))
	replay := append(append([]byte{}, pub...), sealed...)
	parsed, _ := parseQRPayload(qr)
	raw := newMailbox(parsed.configServerURL, dispMgr.httpClient)
	if err := raw.put(context.Background(), id, slotA, replay); err != nil {
		t.Fatal(err)
	}

	waitState(t, dispMgr, id, StateFailed)
	if _, err := dispMgr.TakeIdentity(id, false, ""); !errors.Is(err, ErrIdentityUnavailable) {
		t.Fatalf("replayed hello produced an identity: %v", err)
	}
}

// TestCancelWipesSecrets: cancel (and replacement by a newer session) must drop
// K, the pairing secret, the ephemeral key and any pending identity payload.
func TestCancelWipesSecrets(t *testing.T) {
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
	if dispMgr.sess.wiped() || scanMgr.sess.wiped() {
		t.Fatal("live sessions should still hold their keys")
	}

	// Holder cancels after approving but before the identity was sent: the
	// mnemonic parked in toSend must go too.
	first := dispMgr.sess
	if err := dispMgr.Cancel(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if v, _ := dispMgr.View(id); v.State != StateCancelled {
		t.Fatalf("state after cancel = %s", v.State)
	}
	if !first.wiped() {
		t.Fatal("cancelled displayer session still holds secrets")
	}

	// Replacement wipes the scanner session the same way.
	old := scanMgr.sess
	if _, _, err := scanMgr.CreateDisplayerSession(LocalIdentity{Configured: false}); err != nil {
		t.Fatal(err)
	}
	if !old.wiped() {
		t.Fatal("replaced scanner session still holds secrets")
	}
}

// TestHolderDropsMnemonicAfterSend: once the identity blob is in the mailbox the
// holder has no reason to keep the mnemonic in session memory.
func TestHolderDropsMnemonicAfterSend(t *testing.T) {
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
	if err := dispMgr.Approve(id, HolderIdentity{Mnemonic: testMnemonic, AID: "AIDdesk"}); err != nil {
		t.Fatal(err)
	}
	waitState(t, dispMgr, id, StateDone)
	dispMgr.sess.mu.Lock()
	toSend := dispMgr.sess.toSend
	dispMgr.sess.mu.Unlock()
	if toSend != nil {
		t.Fatal("holder still holds the identity payload after sending it")
	}
	// The receiver still has it for the one-shot read.
	if p, err := scanMgr.TakeIdentity(id, false, ""); err != nil || p.Mnemonic != testMnemonic {
		t.Fatalf("receiver TakeIdentity = %+v, %v", p, err)
	}
}

// TestApproveRejectedOutsideHolderProceedingState: the fresh side, a
// non-proceeding outcome, and a session that has not seen a hello all refuse
// Approve with ErrWrongState (409).
func TestApproveRejectedOutsideHolderProceedingState(t *testing.T) {
	dispMgr, scanMgr, done := twoManagers(t, 0)
	defer done()

	// Before any hello: nothing to approve.
	view, qr, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk", DeviceName: "Desktop"})
	if err != nil {
		t.Fatal(err)
	}
	id := view.SessionID
	if err := dispMgr.Approve(id, HolderIdentity{Mnemonic: testMnemonic}); !errors.Is(err, ErrWrongState) {
		t.Fatalf("Approve before hello = %v, want ErrWrongState", err)
	}

	// Fresh scanner: may never approve.
	if _, err := scanMgr.Scan(context.Background(), qr, "Phone", LocalIdentity{Configured: false}); err != nil {
		t.Fatal(err)
	}
	if err := scanMgr.Approve(id, HolderIdentity{Mnemonic: testMnemonic}); !errors.Is(err, ErrWrongState) {
		t.Fatalf("Approve on the fresh side = %v, want ErrWrongState", err)
	}

	// Conflict outcome: neither side may approve.
	d2, s2, done2 := twoManagers(t, 0)
	defer done2()
	v2, qr2, _ := d2.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDX"})
	if _, err := s2.Scan(context.Background(), qr2, "Phone", LocalIdentity{Configured: true, AID: "AIDY"}); err != nil {
		t.Fatal(err)
	}
	waitState(t, d2, v2.SessionID, StateAcked)
	if err := d2.Approve(v2.SessionID, HolderIdentity{Mnemonic: testMnemonic}); !errors.Is(err, ErrWrongState) {
		t.Fatalf("Approve on conflict (displayer) = %v, want ErrWrongState", err)
	}
	if err := s2.Approve(v2.SessionID, HolderIdentity{Mnemonic: testMnemonic}); !errors.Is(err, ErrWrongState) {
		t.Fatalf("Approve on conflict (scanner) = %v, want ErrWrongState", err)
	}
}

// TestScanRejectsForeignConfigServer: the QR's cs must match this backend's
// config server (cross-environment guard, spec §2); trailing slash and case
// differences are tolerated.
func TestScanRejectsForeignConfigServer(t *testing.T) {
	dispMgr, _, done := twoManagers(t, 0)
	defer done()
	_, qr, err := dispMgr.CreateDisplayerSession(LocalIdentity{Configured: true, AID: "AIDdesk"})
	if err != nil {
		t.Fatal(err)
	}

	foreign := NewManager("http://elsewhere.example:3904", WithHTTPClient(dispMgr.httpClient))
	if _, err := foreign.Scan(context.Background(), qr, "Phone", LocalIdentity{}); !errors.Is(err, ErrConfigServerMismatch) {
		t.Fatalf("foreign scan = %v, want ErrConfigServerMismatch", err)
	}
	if foreign.sess != nil {
		t.Fatal("a refused scan must not install a session")
	}

	for _, c := range []struct {
		a, b string
		same bool
	}{
		{"http://localhost:3904", "http://localhost:3904/", true},
		{"HTTP://Localhost:3904", "http://localhost:3904", true},
		{"http://awa.matou.nz:3904/tenant", "http://awa.matou.nz:3904/tenant/", true},
		{"http://awa.matou.nz:3904/tenant", "http://awa.matou.nz:3904/other", false},
		{"http://localhost:3904", "http://localhost:4904", false},
		{"", "http://localhost:3904", false},
	} {
		if got := sameConfigServer(c.a, c.b); got != c.same {
			t.Errorf("sameConfigServer(%q,%q) = %v, want %v", c.a, c.b, got, c.same)
		}
	}
}
