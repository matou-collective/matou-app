package pairing

import (
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"sync"
	"time"
)

// State is a pairing session's lifecycle state (issue #471 / spec §2):
//
//	created → hello-received → acked → (approved | rejected)
//	        → identity-sent | identity-received → done | cancelled | expired | failed
//
// failed is the terminal state a driver error lands in (mailbox unreachable,
// a blob that did not authenticate, a filled slot): the session's goroutine has
// exited, its secrets are wiped, and Approve/TakeIdentity are refused; the UI
// shows the error and offers a new QR.
type State string

// Session lifecycle states.
const (
	StateCreated          State = "created"
	StateHelloReceived    State = "hello-received"
	StateAcked            State = "acked"
	StateApproved         State = "approved"
	StateRejected         State = "rejected"
	StateIdentitySent     State = "identity-sent"
	StateIdentityReceived State = "identity-received"
	StateDone             State = "done"
	StateCancelled        State = "cancelled"
	StateExpired          State = "expired"
	StateFailed           State = "failed"
)

func isTerminal(s State) bool {
	return s == StateDone || s == StateCancelled || s == StateExpired || s == StateFailed
}

// stopper is the subset of *time.Timer the session needs; nil-safe via stop().
type stopper interface{ Stop() bool }

func stop(t stopper) {
	if t != nil {
		t.Stop()
	}
}

// mailbox slots. The scanner always writes a; the displayer always writes b.
const (
	slotA = "a"
	slotB = "b"
)

// pollWaitSeconds is the mailbox long-poll window; a var so tests can shorten it.
var pollWaitSeconds = 25

// sessionKind is which side of the protocol this backend is running.
type sessionKind string

const (
	kindDisplayer sessionKind = "displayer"
	kindScanner   sessionKind = "scanner"
)

// SessionView is the redaction-safe snapshot returned to the API layer and
// pushed over SSE. It carries no secret.
type SessionView struct {
	SessionID      string    `json:"sessionId"`
	State          State     `json:"state"`
	Outcome        Outcome   `json:"outcome,omitempty"`
	Code           string    `json:"code,omitempty"`
	PeerDeviceName string    `json:"peerDeviceName,omitempty"`
	Error          string    `json:"error,omitempty"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

// session is one live pairing session. There is at most one per backend. Every
// field that could leak a secret is redacted by String(); nothing here is ever
// persisted or logged.
type session struct {
	id   string      // pairing id == mailbox key == sessionID
	kind sessionKind // displayer or scanner

	eph        *ecdh.PrivateKey
	pairSecret []byte
	k          []byte // session key; nil until derived
	code       string

	configServerURL string
	qr              string // displayer only
	deviceName      string // this device's name
	appVersion      string

	// local identity snapshot taken when the session was created.
	localHolds bool
	localAID   string

	// derived after the handshake.
	state          State
	outcome        Outcome
	peerDeviceName string
	errMsg         string

	// holder side: identity to send, set at Approve; approveCh is closed once.
	toSend    *identityMsg
	approveCh chan struct{}
	approved  bool

	// timer fires markExpired at the TTL; stopped on teardown.
	timer stopper

	// receiver side: identity received; read exactly once via TakeIdentity.
	received      *identityMsg
	receivedTaken bool

	createdAt time.Time
	expiresAt time.Time

	mailbox *mailbox
	emit    func(SessionView)
	now     func() time.Time

	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex

	inSlot  string // slot this side reads
	outSlot string // slot this side writes
}

// String redacts every secret (k, pairSecret, mnemonic payloads).
func (s *session) String() string {
	return fmt.Sprintf("session{id:%s kind:%s state:%s outcome:%s code:%s peer:%s k:[REDACTED] pairSecret:[REDACTED] toSend:[REDACTED] received:[REDACTED]}",
		s.id, s.kind, s.state, s.outcome, s.code, s.peerDeviceName)
}

// GoString redacts for %#v.
func (s *session) GoString() string { return s.String() }

// viewLocked builds the redaction-safe view. Caller holds mu.
func (s *session) viewLocked() SessionView {
	return SessionView{
		SessionID:      s.id,
		State:          s.state,
		Outcome:        s.outcome,
		Code:           s.code,
		PeerDeviceName: s.peerDeviceName,
		Error:          s.errMsg,
		ExpiresAt:      s.expiresAt,
	}
}

// view returns the redaction-safe snapshot.
func (s *session) view() SessionView {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewLocked()
}

// update mutates the session under the lock, then emits the new view (outside
// the lock). A terminal state is never overwritten by a non-identical one, so a
// late timer/cancel never clobbers a completed handshake.
func (s *session) update(fn func()) {
	s.mu.Lock()
	prev := s.state
	fn()
	if isTerminal(prev) && s.state != prev {
		s.state = prev // refuse to leave a terminal state
	}
	view := s.viewLocked()
	emit := s.emit
	s.mu.Unlock()
	if emit != nil {
		emit(view)
	}
}

// setState transitions to st (respecting terminal states) and emits.
func (s *session) setState(st State) {
	s.update(func() { s.state = st })
}

// wipeLocked drops every secret the session holds: the session key, the
// pairing secret, the ephemeral private key and any identity payload (the
// mnemonic) waiting to be sent or read. Byte slices are zeroed before being
// dropped. Caller holds mu. Called on every teardown (cancel, expiry, failure,
// replacement) so a finished or abandoned session keeps nothing in memory.
func (s *session) wipeLocked() {
	for i := range s.k {
		s.k[i] = 0
	}
	s.k = nil
	for i := range s.pairSecret {
		s.pairSecret[i] = 0
	}
	s.pairSecret = nil
	s.eph = nil
	s.toSend = nil
	s.received = nil
}

// wiped reports whether every secret has been dropped (tests).
func (s *session) wiped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.k == nil && s.pairSecret == nil && s.eph == nil && s.toSend == nil && s.received == nil
}

// teardown moves a non-terminal session into the terminal state st (recording
// errMsg if given), wipes its secrets, stops the expiry timer and cancels the
// driver context. A session already in a terminal state keeps its state but is
// still wiped when force is set (explicit cancel / replacement).
func (s *session) teardown(st State, errMsg string, force bool) {
	s.mu.Lock()
	changed := false
	if !isTerminal(s.state) {
		s.state = st
		if errMsg != "" && s.errMsg == "" {
			s.errMsg = errMsg
		}
		changed = true
	}
	if changed || force {
		s.wipeLocked()
	}
	view := s.viewLocked()
	emit := s.emit
	timer := s.timer
	s.mu.Unlock()
	stop(timer)
	if s.cancel != nil {
		s.cancel()
	}
	if changed && emit != nil {
		emit(view)
	}
}

// markCancelled tears the session down as cancelled and wipes its secrets
// (even if it had already finished: an explicit cancel or replacement means
// nothing about it should linger).
func (s *session) markCancelled() { s.teardown(StateCancelled, "", true) }

// markExpired transitions to expired (wiping secrets) unless already terminal.
func (s *session) markExpired() { s.teardown(StateExpired, "", false) }

// markFailed records a driver error as the terminal failed state and wipes
// secrets, unless already terminal.
func (s *session) markFailed(err error) { s.teardown(StateFailed, err.Error(), false) }

// expired reports whether the session has passed its TTL.
func (s *session) expired() bool {
	return s.now().After(s.expiresAt)
}

// pollSlot long-polls one mailbox slot until a blob arrives, the context is
// cancelled, or the session TTL passes. A 204 quiet timeout loops again.
func (s *session) pollSlot(ctx context.Context, slot string) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if s.expired() {
			return nil, errMailboxExpired
		}
		blob, err := s.mailbox.get(ctx, s.id, slot, pollWaitSeconds)
		if err != nil {
			var rerr *retryError
			if errors.As(err, &rerr) {
				if werr := s.sleepRetry(ctx, rerr.after); werr != nil {
					return nil, werr
				}
				continue
			}
			return nil, err
		}
		if blob != nil {
			return blob, nil
		}
	}
}

// putSlot writes a blob to the mailbox, waiting out transient answers
// (429 rate limit, 503 capacity, gateway errors) until the context is
// cancelled or the session TTL passes.
func (s *session) putSlot(ctx context.Context, slot string, blob []byte) error {
	for {
		err := s.mailbox.put(ctx, s.id, slot, blob)
		var rerr *retryError
		if !errors.As(err, &rerr) {
			return err
		}
		if werr := s.sleepRetry(ctx, rerr.after); werr != nil {
			return werr
		}
	}
}

// sleepRetry waits d (or until ctx is done / the session expires).
func (s *session) sleepRetry(ctx context.Context, d time.Duration) error {
	if s.expired() {
		return errMailboxExpired
	}
	if remaining := s.expiresAt.Sub(s.now()); d > remaining {
		d = remaining
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
