package pairing

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultTTL is a pairing session's lifetime from creation (spec §2).
const DefaultTTL = 5 * time.Minute

// Manager owns at most one pairing session per backend (one displayer or one
// scanner at a time). A second CreateDisplayerSession or Scan cancels the first.
// It holds no persistent state — a restart cancels any session.
type Manager struct {
	configServerURL string
	appVersion      string
	httpClient      *http.Client
	emit            func(SessionView)
	now             func() time.Time
	ttl             time.Duration

	mu   sync.Mutex
	sess *session
}

// ManagerOption configures a Manager.
type ManagerOption func(*Manager)

// WithHTTPClient overrides the HTTP client used for mailbox calls.
func WithHTTPClient(c *http.Client) ManagerOption {
	return func(m *Manager) { m.httpClient = c }
}

// WithEmit registers a callback invoked with the fresh view on every state
// change (wired to the SSE broker's pairing:state event).
func WithEmit(fn func(SessionView)) ManagerOption {
	return func(m *Manager) { m.emit = fn }
}

// WithNow overrides the clock (tests).
func WithNow(fn func() time.Time) ManagerOption {
	return func(m *Manager) { m.now = fn }
}

// WithTTL overrides the session lifetime (tests).
func WithTTL(d time.Duration) ManagerOption {
	return func(m *Manager) { m.ttl = d }
}

// WithAppVersion sets the app version reported in the hello.
func WithAppVersion(v string) ManagerOption {
	return func(m *Manager) { m.appVersion = v }
}

// NewManager builds a Manager whose displayer QR and mailbox base use
// configServerURL (this backend's own config server).
func NewManager(configServerURL string, opts ...ManagerOption) *Manager {
	m := &Manager{
		configServerURL: configServerURL,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
		now:             time.Now,
		ttl:             DefaultTTL,
	}
	for _, o := range opts {
		o(m)
	}
	return m
}

// LocalIdentity is this backend's identity snapshot the protocol needs at
// session start: whether it holds an identity and its AID + device name.
type LocalIdentity struct {
	Configured bool
	AID        string
	DeviceName string
}

// HolderIdentity is the full payload the holder sends on Approve.
type HolderIdentity struct {
	Mnemonic        string
	AID             string
	OrgAID          string
	AdminAID        string
	ConfigServerURL string
}

// IdentityPayload is the receiver's one-shot copy of the received identity.
type IdentityPayload struct {
	Mnemonic        string `json:"mnemonic"`
	AID             string `json:"aid"`
	OrgAID          string `json:"orgAid,omitempty"`
	AdminAID        string `json:"adminAid,omitempty"`
	ConfigServerURL string `json:"configServerUrl,omitempty"`
}

// Sentinel errors mapped to HTTP status by the API layer.
var (
	// ErrNoSession — no session with that id (404).
	ErrNoSession = errors.New("pairing: no such session")
	// ErrExpired — the session has passed its TTL (410).
	ErrExpired = errors.New("pairing: session expired")
	// ErrWrongState — the operation is not valid in the current state (409).
	ErrWrongState = errors.New("pairing: operation not valid in current state")
	// ErrIdentityUnavailable — no identity to hand out (not received yet or
	// already read once) (404).
	ErrIdentityUnavailable = errors.New("pairing: identity not available")
	// ErrConfigServerMismatch — the QR's cs field names a different config
	// server than this backend uses (400). The cs field exists to stop a
	// cross-environment scan (spec §2): a test-build phone must not pair
	// through a production mailbox and pull a production identity into a test
	// data dir, and a QR from a stranger must not steer this backend's mailbox
	// traffic to an arbitrary host.
	ErrConfigServerMismatch = errors.New("pairing: QR code is for a different config server")
)

// sameConfigServer compares two config-server base URLs, ignoring case in the
// scheme and host and a trailing slash on the path (tenant prefix included).
func sameConfigServer(a, b string) bool {
	norm := func(raw string) (string, bool) {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || u.Scheme == "" || u.Host == "" {
			return "", false
		}
		return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + strings.TrimRight(u.Path, "/"), true
	}
	na, oka := norm(a)
	nb, okb := norm(b)
	return oka && okb && na == nb
}

// IdentityPresentError (409) is returned by TakeIdentity when this backend
// already holds an identity: linking never overwrites (spec §3.3).
type IdentityPresentError struct{ AID string }

func (e *IdentityPresentError) Error() string {
	return fmt.Sprintf("pairing: identity already present (%s)", e.AID)
}

// current returns the session if its id matches, else nil.
func (m *Manager) current(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess != nil && m.sess.id == id {
		return m.sess
	}
	return nil
}

// replace cancels any existing session and installs sn as the current one.
func (m *Manager) replace(sn *session) {
	m.mu.Lock()
	old := m.sess
	m.sess = sn
	m.mu.Unlock()
	if old != nil {
		old.markCancelled() // stops the expiry timer and wipes secrets
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = old.mailbox.del(ctx, old.id)
		}()
	}
}

// newSession builds the common skeleton of a session.
func (m *Manager) newSession(kind sessionKind, id string, mb *mailbox, local LocalIdentity, inSlot, outSlot string) *session {
	ctx, cancel := context.WithCancel(context.Background())
	created := m.now()
	s := &session{
		id:              id,
		kind:            kind,
		configServerURL: m.configServerURL,
		deviceName:      local.DeviceName,
		appVersion:      m.appVersion,
		localHolds:      local.Configured,
		localAID:        local.AID,
		state:           StateCreated,
		approveCh:       make(chan struct{}),
		createdAt:       created,
		expiresAt:       created.Add(m.ttl),
		mailbox:         mb,
		emit:            m.emit,
		now:             m.now,
		ctx:             ctx,
		cancel:          cancel,
		inSlot:          inSlot,
		outSlot:         outSlot,
	}
	// The timer callback (markExpired → teardown) reads s.timer under s.mu, so
	// the assignment is made under the same lock: with a tiny TTL the callback
	// can run before this function returns.
	s.mu.Lock()
	s.timer = time.AfterFunc(m.ttl, s.markExpired)
	s.mu.Unlock()
	return s
}

// CreateDisplayerSession starts a displayer session, returns the QR payload and
// the initial view, and begins driving the exchange in the background.
func (m *Manager) CreateDisplayerSession(local LocalIdentity) (SessionView, string, error) {
	eph, err := generateEphemeralKey()
	if err != nil {
		return SessionView{}, "", err
	}
	idBytes, err := randomBytes(idSize)
	if err != nil {
		return SessionView{}, "", err
	}
	secret, err := randomBytes(secretSize)
	if err != nil {
		return SessionView{}, "", err
	}
	id := b64.EncodeToString(idBytes)

	qr := qrPayload{
		version:         "1",
		pairID:          id,
		displayerPub:    eph.PublicKey().Bytes(),
		pairSecret:      secret,
		configServerURL: m.configServerURL,
	}

	mb := newMailbox(m.configServerURL, m.httpClient)
	s := m.newSession(kindDisplayer, id, mb, local, slotA, slotB)
	s.eph = eph
	s.pairSecret = secret
	s.qr = qr.encode()

	m.replace(s)
	go s.driveDisplayer(s.ctx)

	return s.view(), s.qr, nil
}

// Scan runs the scanner side: it parses the QR, sends hello, waits for the ack,
// and returns the outcome/code. The identity-transfer phase then continues in
// the background. ctx bounds only the synchronous ack wait.
func (m *Manager) Scan(ctx context.Context, qrText, deviceName string, local LocalIdentity) (SessionView, error) {
	qr, err := parseQRPayload(qrText)
	if err != nil {
		return SessionView{}, err
	}
	if !sameConfigServer(qr.configServerURL, m.configServerURL) {
		return SessionView{}, ErrConfigServerMismatch
	}
	eph, err := generateEphemeralKey()
	if err != nil {
		return SessionView{}, err
	}
	local.DeviceName = deviceName

	mb := newMailbox(qr.configServerURL, m.httpClient)
	s := m.newSession(kindScanner, qr.pairID, mb, local, slotB, slotA)
	s.eph = eph
	s.pairSecret = qr.pairSecret
	s.configServerURL = qr.configServerURL

	m.replace(s)

	// Bound the synchronous ack wait by both the request context and the
	// session context (which cancels on replace/expiry/cancel).
	waitCtx, stopWait := context.WithCancel(s.ctx)
	defer stopWait()
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				stopWait()
			case <-waitCtx.Done():
			}
		}()
	}

	if err := s.sendHelloWaitAck(waitCtx, qr.displayerPub); err != nil {
		s.markCancelled()
		return SessionView{}, err
	}

	go s.transfer(s.ctx)
	return s.view(), nil
}

// Approve is called on the holder to release the identity to the receiver.
func (m *Manager) Approve(id string, holder HolderIdentity) error {
	s := m.current(id)
	if s == nil {
		return ErrNoSession
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == StateExpired {
		return ErrExpired
	}
	if s.approved {
		return nil // idempotent
	}
	if !s.localHolds || !s.outcome.proceeds() {
		return ErrWrongState
	}
	if s.state != StateAcked && s.state != StateHelloReceived {
		return ErrWrongState
	}
	s.approved = true
	s.toSend = &identityMsg{
		Mnemonic:        holder.Mnemonic,
		AID:             holder.AID,
		OrgAID:          holder.OrgAID,
		AdminAID:        holder.AdminAID,
		ConfigServerURL: holder.ConfigServerURL,
	}
	s.state = StateApproved
	close(s.approveCh)
	return nil
}

// Cancel tears the session down and best-effort deletes the mailbox id.
func (m *Manager) Cancel(ctx context.Context, id string) error {
	s := m.current(id)
	if s == nil {
		return ErrNoSession
	}
	s.markCancelled()
	_ = s.mailbox.del(ctx, s.id)
	return nil
}

// View returns the current session's snapshot. ErrNoSession if the id is
// unknown; ErrExpired once it has passed its TTL.
func (m *Manager) View(id string) (SessionView, error) {
	s := m.current(id)
	if s == nil {
		return SessionView{}, ErrNoSession
	}
	v := s.view()
	if v.State == StateExpired {
		return v, ErrExpired
	}
	return v, nil
}

// TakeIdentity returns the received identity exactly once, then wipes it from
// memory. localConfigured/localAID reflect this backend's current identity: a
// configured backend refuses with IdentityPresentError unless the outcome was
// already-linked (spec §3.3).
func (m *Manager) TakeIdentity(id string, localConfigured bool, localAID string) (IdentityPayload, error) {
	s := m.current(id)
	if s == nil {
		return IdentityPayload{}, ErrNoSession
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == StateExpired {
		return IdentityPayload{}, ErrExpired
	}
	if localConfigured && s.outcome != OutcomeAlreadyLinked {
		return IdentityPayload{}, &IdentityPresentError{AID: localAID}
	}
	if s.received == nil || s.receivedTaken {
		return IdentityPayload{}, ErrIdentityUnavailable
	}
	msg := s.received
	payload := IdentityPayload{
		Mnemonic:        msg.Mnemonic,
		AID:             msg.AID,
		OrgAID:          msg.OrgAID,
		AdminAID:        msg.AdminAID,
		ConfigServerURL: msg.ConfigServerURL,
	}
	// Wipe from memory after the single read.
	s.received = nil
	s.receivedTaken = true
	return payload, nil
}
