package pairing

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestKeyAgreementBothSidesDeriveSameK(t *testing.T) {
	displayer, err := generateEphemeralKey()
	if err != nil {
		t.Fatal(err)
	}
	scanner, err := generateEphemeralKey()
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := randomBytes(secretSize)

	kDisplayer, err := deriveK(displayer, scanner.PublicKey(), secret)
	if err != nil {
		t.Fatal(err)
	}
	kScanner, err := deriveK(scanner, displayer.PublicKey(), secret)
	if err != nil {
		t.Fatal(err)
	}
	if string(kDisplayer) != string(kScanner) {
		t.Fatalf("K mismatch: %x != %x", kDisplayer, kScanner)
	}
	if len(kDisplayer) != keySize {
		t.Fatalf("K length = %d, want %d", len(kDisplayer), keySize)
	}

	// Same K → same 6-digit code on both screens.
	if c1, c2 := sasCode(kDisplayer), sasCode(kScanner); c1 != c2 {
		t.Fatalf("code mismatch: %s != %s", c1, c2)
	}
	if got := sasCode(kDisplayer); len(got) != codeDigits {
		t.Fatalf("code length = %d, want %d", len(got), codeDigits)
	}
}

func TestWrongPairSecretFailsAEAD(t *testing.T) {
	displayer, _ := generateEphemeralKey()
	scanner, _ := generateEphemeralKey()
	secretA, _ := randomBytes(secretSize)
	secretB, _ := randomBytes(secretSize)

	kScanner, _ := deriveK(scanner, displayer.PublicKey(), secretA)
	kDisplayer, _ := deriveK(displayer, scanner.PublicKey(), secretB) // wrong secret

	blob, err := seal(kScanner, []byte(`{"role":"holder"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := open(kDisplayer, blob); err == nil {
		t.Fatal("expected AEAD open to fail with a mismatched pair secret")
	}

	// Sanity: the correct key opens it.
	kDisplayerOK, _ := deriveK(displayer, scanner.PublicKey(), secretA)
	if _, err := open(kDisplayerOK, blob); err != nil {
		t.Fatalf("correct key failed to open: %v", err)
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	k, _ := randomBytes(keySize)
	msg := []byte("the quick brown fox")
	blob, err := seal(k, msg)
	if err != nil {
		t.Fatal(err)
	}
	if len(blob) < nonceSize {
		t.Fatal("blob shorter than nonce")
	}
	got, err := open(k, blob)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(msg) {
		t.Fatalf("round trip mismatch: %q", got)
	}
	if _, err := open(k, blob[:nonceSize-1]); err == nil {
		t.Fatal("expected short-blob open to fail")
	}
}

func TestQRPayloadRoundTrip(t *testing.T) {
	eph, _ := generateEphemeralKey()
	secret, _ := randomBytes(secretSize)
	id, _ := randomBytes(idSize)
	q := qrPayload{
		version:         "1",
		pairID:          b64.EncodeToString(id),
		displayerPub:    eph.PublicKey().Bytes(),
		pairSecret:      secret,
		configServerURL: "http://localhost:3904",
	}
	encoded := q.encode()
	if !strings.HasPrefix(encoded, "matou://pair?") {
		t.Fatalf("bad prefix: %s", encoded)
	}
	parsed, err := parseQRPayload(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.pairID != q.pairID {
		t.Errorf("pairID mismatch")
	}
	if string(parsed.displayerPub) != string(q.displayerPub) {
		t.Errorf("displayerPub mismatch")
	}
	if string(parsed.pairSecret) != string(q.pairSecret) {
		t.Errorf("pairSecret mismatch")
	}
	if parsed.configServerURL != q.configServerURL {
		t.Errorf("configServerURL mismatch")
	}
}

func TestQRPayloadRedactsSecret(t *testing.T) {
	q := qrPayload{pairSecret: []byte("supersecretvalue")}
	for _, s := range []string{q.String(), q.GoString()} {
		if strings.Contains(s, "supersecretvalue") {
			t.Fatalf("qrPayload leaked its secret: %s", s)
		}
		if !strings.Contains(s, "REDACTED") {
			t.Fatalf("expected REDACTED marker: %s", s)
		}
	}
}

func TestParseQRPayloadRejectsBad(t *testing.T) {
	cases := []string{
		"https://pair?v=1",                             // wrong scheme
		"matou://pair?v=2&id=x",                        // wrong version
		"matou://pair?v=1",                             // missing id
		"matou://pair?v=1&id=!!!&pk=x&s=y&cs=http://x", // bad base64 id
	}
	for _, c := range cases {
		if _, err := parseQRPayload(c); err == nil {
			t.Errorf("expected parse error for %q", c)
		}
	}
}

func TestComputeOutcome(t *testing.T) {
	cases := []struct {
		name   string
		dHolds bool
		dAID   string
		sHolds bool
		sAID   string
		want   Outcome
	}{
		{"both fresh", false, "", false, "", OutcomeNeither},
		{"phone holds", false, "", true, "AIDX", OutcomePhoneToDesktop},
		{"desktop holds", true, "AIDX", false, "", OutcomeDesktopToPhone},
		{"same aid", true, "AIDX", true, "AIDX", OutcomeAlreadyLinked},
		{"diff aid", true, "AIDX", true, "AIDY", OutcomeConflict},
	}
	for _, c := range cases {
		if got := computeOutcome(c.dHolds, c.dAID, c.sHolds, c.sAID); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestMailboxClientSingleReadAnd409(t *testing.T) {
	mem := newMemMailbox(5 * time.Minute)
	srv := mem.server()
	defer srv.Close()
	mb := newMailbox(srv.URL, srv.Client())
	ctx := context.Background()

	if err := mb.put(ctx, "id1", slotA, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	// Second put to a filled slot → 409.
	if err := mb.put(ctx, "id1", slotA, []byte("again")); err != errSlotFilled {
		t.Fatalf("expected errSlotFilled, got %v", err)
	}
	// GET reads and deletes (single read).
	blob, err := mb.get(ctx, "id1", slotA, 1)
	if err != nil {
		t.Fatal(err)
	}
	if string(blob) != "hello" {
		t.Fatalf("got %q", blob)
	}
	// Now the slot is empty; a bounded GET times out with 204 → (nil, nil).
	start := time.Now()
	blob, err = mb.get(ctx, "id1", slotA, 1)
	if err != nil || blob != nil {
		t.Fatalf("expected quiet timeout, got blob=%q err=%v", blob, err)
	}
	if time.Since(start) < 500*time.Millisecond {
		t.Fatalf("long-poll returned too quickly")
	}
}

func TestMailboxClientExpired404(t *testing.T) {
	mem := newMemMailbox(20 * time.Millisecond)
	srv := mem.server()
	defer srv.Close()
	mb := newMailbox(srv.URL, srv.Client())
	ctx := context.Background()

	if err := mb.put(ctx, "id1", slotA, []byte("x")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if _, err := mb.get(ctx, "id1", slotA, 1); err != errMailboxExpired {
		t.Fatalf("expected errMailboxExpired, got %v", err)
	}
	if err := mb.put(ctx, "id1", slotB, []byte("y")); err != errMailboxExpired {
		t.Fatalf("expected errMailboxExpired on put, got %v", err)
	}
}
