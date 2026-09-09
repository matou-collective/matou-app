package pairing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// driveDisplayer runs the whole displayer side in the background: it long-polls
// slot a for the scanner's hello, derives K, sends the ack on slot b, then runs
// the shared transfer phase. The QR is already returned to the caller.
func (s *session) driveDisplayer(ctx context.Context) {
	blob, err := s.pollSlot(ctx, slotA)
	if err != nil {
		s.finishOnError(err)
		return
	}
	// hello blob = scannerEphPub(32, clear) ‖ seal(K, helloPlaintext).
	if len(blob) < 32+nonceSize {
		s.finishOnError(fmt.Errorf("pairing: malformed hello"))
		return
	}
	peerPub, err := parsePeerPublicKey(blob[:32])
	if err != nil {
		s.finishOnError(err)
		return
	}
	k, err := deriveK(s.eph, peerPub, s.pairSecret)
	if err != nil {
		s.finishOnError(err)
		return
	}
	plain, err := open(k, blob[32:])
	if err != nil {
		// A tampered peer key or a cross-session scan fails the AEAD tag here.
		s.finishOnError(fmt.Errorf("pairing: hello did not authenticate: %w", err))
		return
	}
	var hello helloMsg
	if err := json.Unmarshal(plain, &hello); err != nil {
		s.finishOnError(err)
		return
	}

	outcome := computeOutcome(s.localHolds, s.localAID, hello.Role == RoleHolder, hello.AID)
	s.update(func() {
		s.k = k
		s.code = sasCode(k)
		s.peerDeviceName = hello.DeviceName
		s.outcome = outcome
		s.state = StateHelloReceived
	})

	// Send ack on slot b.
	ack := ackMsg{Role: s.localRole(), AID: s.localAID, DeviceName: s.deviceName}
	if err := s.sealPut(ctx, s.outSlot, ack); err != nil {
		s.finishOnError(err)
		return
	}
	s.setState(StateAcked)

	s.transfer(ctx)
}

// sendHelloWaitAck runs the scanner handshake synchronously: it derives K from
// the displayer's public key in the QR, writes hello on slot a, then long-polls
// slot b for the ack. On success the session is in state acked with the outcome
// and code set. Called from Manager.Scan so the HTTP response carries the ack.
func (s *session) sendHelloWaitAck(ctx context.Context, displayerPub []byte) error {
	peerPub, err := parsePeerPublicKey(displayerPub)
	if err != nil {
		return err
	}
	k, err := deriveK(s.eph, peerPub, s.pairSecret)
	if err != nil {
		return err
	}
	s.update(func() {
		s.k = k
		s.code = sasCode(k)
	})

	hello := helloMsg{
		Role:       s.localRole(),
		AID:        s.localAID,
		DeviceName: s.deviceName,
		AppVersion: s.appVersion,
	}
	plain, err := json.Marshal(hello)
	if err != nil {
		return err
	}
	sealed, err := seal(k, plain)
	if err != nil {
		return err
	}
	// scannerEphPub travels in the clear so the displayer can derive K.
	blob := append(append([]byte{}, s.eph.PublicKey().Bytes()...), sealed...)
	if err := s.mailbox.put(ctx, s.id, s.outSlot, blob); err != nil {
		return err
	}

	ackBlob, err := s.pollSlot(ctx, s.inSlot)
	if err != nil {
		return err
	}
	ackPlain, err := open(k, ackBlob)
	if err != nil {
		return fmt.Errorf("pairing: ack did not authenticate: %w", err)
	}
	var ack ackMsg
	if err := json.Unmarshal(ackPlain, &ack); err != nil {
		return err
	}
	outcome := computeOutcome(ack.Role == RoleHolder, ack.AID, s.localHolds, s.localAID)
	s.update(func() {
		s.peerDeviceName = ack.DeviceName
		s.outcome = outcome
		s.state = StateAcked
	})
	return nil
}

// transfer runs the identity-transfer phase shared by both sides. For a
// proceeding outcome exactly one side holds the identity: the holder waits for
// Approve then sends identity and awaits done; the receiver reads identity and
// replies done.
func (s *session) transfer(ctx context.Context) {
	s.mu.Lock()
	outcome := s.outcome
	holds := s.localHolds
	s.mu.Unlock()

	if !outcome.proceeds() {
		// neither / already-linked / conflict: nothing more to exchange.
		return
	}

	if holds {
		s.runHolder(ctx)
	} else {
		s.runReceiver(ctx)
	}
}

// runHolder waits for the local Approve, sends the identity on the outbound
// slot, then awaits the receiver's done on the inbound slot.
func (s *session) runHolder(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-s.approveCh:
	}
	s.mu.Lock()
	msg := s.toSend
	k := s.k
	s.mu.Unlock()
	if msg == nil {
		s.finishOnError(fmt.Errorf("pairing: approved with no identity to send"))
		return
	}
	plain, err := json.Marshal(msg)
	if err != nil {
		s.finishOnError(err)
		return
	}
	sealed, err := seal(k, plain)
	if err != nil {
		s.finishOnError(err)
		return
	}
	if err := s.mailbox.put(ctx, s.id, s.outSlot, sealed); err != nil {
		s.finishOnError(err)
		return
	}
	s.setState(StateIdentitySent)

	doneBlob, err := s.pollSlot(ctx, s.inSlot)
	if err != nil {
		s.finishOnError(err)
		return
	}
	donePlain, err := open(k, doneBlob)
	if err != nil {
		s.finishOnError(fmt.Errorf("pairing: done did not authenticate: %w", err))
		return
	}
	var done doneMsg
	if err := json.Unmarshal(donePlain, &done); err != nil {
		s.finishOnError(err)
		return
	}
	s.update(func() {
		if !done.OK {
			s.errMsg = done.Error
		}
		s.state = StateDone
	})
}

// runReceiver reads the identity on the inbound slot, stores it for the one-shot
// GET, then replies done on the outbound slot.
func (s *session) runReceiver(ctx context.Context) {
	s.mu.Lock()
	k := s.k
	s.mu.Unlock()

	idBlob, err := s.pollSlot(ctx, s.inSlot)
	if err != nil {
		s.finishOnError(err)
		return
	}
	idPlain, err := open(k, idBlob)
	if err != nil {
		s.finishOnError(fmt.Errorf("pairing: identity did not authenticate: %w", err))
		return
	}
	var id identityMsg
	if err := json.Unmarshal(idPlain, &id); err != nil {
		s.finishOnError(err)
		return
	}
	s.update(func() {
		s.received = &id
		s.state = StateIdentityReceived
	})

	done := doneMsg{OK: true}
	if err := s.sealPut(ctx, s.outSlot, done); err != nil {
		// The receiver already holds the identity; a failure to send done is
		// non-fatal for the receiver but the holder will not see "Linked ✓".
		s.finishOnError(err)
		return
	}
	s.setState(StateDone)
}

// localRole reports whether this backend holds an identity (holder) or not
// (fresh).
func (s *session) localRole() Role {
	if s.localHolds {
		return RoleHolder
	}
	return RoleFresh
}

// sealPut marshals, seals under K and PUTs a message to the given slot.
func (s *session) sealPut(ctx context.Context, slot string, msg any) error {
	s.mu.Lock()
	k := s.k
	s.mu.Unlock()
	plain, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	sealed, err := seal(k, plain)
	if err != nil {
		return err
	}
	return s.mailbox.put(ctx, s.id, slot, sealed)
}

// finishOnError records a non-terminal driver error. Context cancellation and
// TTL expiry are not errors — they are handled by cancel/expiry paths — so they
// leave the state as cancelled/expired rather than logging a spurious failure.
func (s *session) finishOnError(err error) {
	if err == nil {
		return
	}
	if errors.Is(err, context.Canceled) {
		return
	}
	if errors.Is(err, errMailboxExpired) || errors.Is(err, context.DeadlineExceeded) {
		s.markExpired()
		return
	}
	s.update(func() {
		if s.errMsg == "" {
			s.errMsg = err.Error()
		}
	})
}
