package pairing

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// TestSealHidesPlaintextAndUsesFreshNonce: the ciphertext must not carry the
// plaintext, and two seals of the same message under the same K must differ in
// both nonce and ciphertext (a repeated GCM nonce would be catastrophic).
func TestSealHidesPlaintextAndUsesFreshNonce(t *testing.T) {
	k, _ := randomBytes(keySize)
	msg := []byte(`{"mnemonic":"zztest1 zztest2 zztest3"}`)
	a, err := seal(k, msg)
	if err != nil {
		t.Fatal(err)
	}
	b, err := seal(k, msg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(a), "zztest1") || strings.Contains(string(b), "zztest1") {
		t.Fatal("ciphertext contains the plaintext")
	}
	if string(a[:nonceSize]) == string(b[:nonceSize]) {
		t.Fatal("two seals reused a nonce")
	}
	if string(a[nonceSize:]) == string(b[nonceSize:]) {
		t.Fatal("two seals produced identical ciphertext")
	}
	// A flipped ciphertext bit fails authentication.
	a[len(a)-1] ^= 1
	if _, err := open(k, a); err == nil {
		t.Fatal("tampered blob opened")
	}
}

// TestMailboxRetriesTransientAnswers: 429 (Retry-After), 503 and a client
// timeout are waited out rather than failing the session, for both the
// long-poll and the put.
func TestMailboxRetriesTransientAnswers(t *testing.T) {
	var mu sync.Mutex
	getCalls, putCalls := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			getCalls++
			switch getCalls {
			case 1:
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
			case 2:
				w.WriteHeader(http.StatusServiceUnavailable)
			case 3:
				time.Sleep(300 * time.Millisecond) // past the client timeout below
				w.WriteHeader(http.StatusNoContent)
			default:
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("blob"))
			}
		case http.MethodPut:
			putCalls++
			if putCalls == 1 {
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			w.WriteHeader(http.StatusCreated)
		}
	}))
	defer srv.Close()

	m := NewManager(srv.URL, WithHTTPClient(&http.Client{Timeout: 150 * time.Millisecond}), WithTTL(10*time.Second))
	s := m.newSession(kindDisplayer, "idretry", newMailbox(srv.URL, m.httpClient), LocalIdentity{}, slotA, slotB)
	defer s.markCancelled()

	start := time.Now()
	blob, err := s.pollSlot(context.Background(), slotA)
	if err != nil || string(blob) != "blob" {
		t.Fatalf("pollSlot = %q, %v", blob, err)
	}
	if time.Since(start) < time.Second {
		t.Fatal("pollSlot did not honour Retry-After")
	}
	if err := s.putSlot(context.Background(), slotB, []byte("x")); err != nil {
		t.Fatalf("putSlot = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if getCalls != 4 || putCalls != 2 {
		t.Fatalf("calls: get=%d put=%d", getCalls, putCalls)
	}
}

// TestRetryStopsAtSessionExpiry: a permanent 429 ends as expired, not as an
// endless loop.
func TestRetryStopsAtSessionExpiry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	m := NewManager(srv.URL, WithHTTPClient(srv.Client()), WithTTL(200*time.Millisecond))
	s := m.newSession(kindDisplayer, "idretry2", newMailbox(srv.URL, m.httpClient), LocalIdentity{}, slotA, slotB)
	defer s.markCancelled()
	if _, err := s.pollSlot(context.Background(), slotA); !errors.Is(err, errMailboxExpired) {
		t.Fatalf("pollSlot under permanent 429 = %v, want errMailboxExpired", err)
	}
}

// TestSASCodeKnownAnswer pins the SAS derivation (spec §2): HMAC-SHA256(K,"sas")
// as a big-endian integer mod 10^6, zero-padded to six digits. The vectors were
// cross-checked against an independent Python computation; both sides of the
// protocol are this package, so a change here silently breaks pairing between
// app versions.
func TestSASCodeKnownAnswer(t *testing.T) {
	k := make([]byte, keySize)
	for i := range k {
		k[i] = byte(i) // 000102…1f
	}
	if got := sasCode(k); got != "590449" {
		t.Fatalf("sasCode(00..1f) = %s, want 590449", got)
	}
	// A code may start with 0 and must keep its leading zero: K = 04 00…00.
	k0 := make([]byte, keySize)
	k0[0] = 4
	if got := sasCode(k0); got != "044175" {
		t.Fatalf("sasCode(04 00..00) = %s, want 044175", got)
	}
	// Always exactly six digits.
	for i := 0; i < 200; i++ {
		rk, _ := randomBytes(keySize)
		c := sasCode(rk)
		if len(c) != codeDigits || strings.Trim(c, "0123456789") != "" {
			t.Fatalf("sasCode = %q, want 6 decimal digits", c)
		}
	}
}
