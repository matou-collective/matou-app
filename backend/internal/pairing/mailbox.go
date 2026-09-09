package pairing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Mailbox errors.
var (
	// errSlotFilled is returned by put when the slot already holds a blob (409).
	errSlotFilled = errors.New("pairing: mailbox slot already filled")
	// errMailboxExpired is returned when the mailbox id has passed its TTL (404).
	errMailboxExpired = errors.New("pairing: mailbox id expired")
)

// maxBlobSize caps a single mailbox blob at 8 KB (spec §2).
const maxBlobSize = 8 << 10

// mailbox is a client for the config-server rendezvous mailbox:
//
//	PUT    <base>/api/pair/{id}/{slot}   store one blob, 409 if filled
//	GET    <base>/api/pair/{id}/{slot}?wait=25  long-poll, single read, 204/404
//	DELETE <base>/api/pair/{id}          best-effort cleanup
//
// base is the config-server URL as the displayer uses it (tenant prefix, if
// any, is already part of the URL); the scanner takes it from the QR's cs field.
type mailbox struct {
	base   string
	client *http.Client
}

// newMailbox builds a mailbox client. The trailing slash on base is trimmed so
// URL joins are stable.
func newMailbox(base string, client *http.Client) *mailbox {
	return &mailbox{base: strings.TrimRight(base, "/"), client: client}
}

func (m *mailbox) url(id, slot string) string {
	return fmt.Sprintf("%s/api/pair/%s/%s", m.base, id, slot)
}

// put stores a blob in the slot. errSlotFilled on 409.
func (m *mailbox) put(ctx context.Context, id, slot string, blob []byte) error {
	if len(blob) > maxBlobSize {
		return fmt.Errorf("pairing: blob exceeds %d bytes", maxBlobSize)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, m.url(id, slot), bytes.NewReader(blob))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("pairing: mailbox put: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return nil
	case http.StatusConflict:
		return errSlotFilled
	case http.StatusNotFound, http.StatusGone:
		return errMailboxExpired
	default:
		return fmt.Errorf("pairing: mailbox put status %d", resp.StatusCode)
	}
}

// get long-polls the slot for up to waitSeconds. It returns:
//   - (blob, nil) when a blob is present (the server deletes it: single read);
//   - (nil, nil) on a quiet timeout (204);
//   - (nil, errMailboxExpired) once the id's TTL has passed (404).
func (m *mailbox) get(ctx context.Context, id, slot string, waitSeconds int) ([]byte, error) {
	u := m.url(id, slot) + "?wait=" + strconv.Itoa(waitSeconds)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("pairing: mailbox get: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK:
		blob, err := io.ReadAll(io.LimitReader(resp.Body, maxBlobSize+1))
		if err != nil {
			return nil, fmt.Errorf("pairing: mailbox read: %w", err)
		}
		if len(blob) > maxBlobSize {
			return nil, fmt.Errorf("pairing: mailbox blob exceeds %d bytes", maxBlobSize)
		}
		return blob, nil
	case http.StatusNoContent:
		return nil, nil
	case http.StatusNotFound, http.StatusGone:
		return nil, errMailboxExpired
	default:
		return nil, fmt.Errorf("pairing: mailbox get status %d", resp.StatusCode)
	}
}

// del best-effort deletes the mailbox id on cancel/teardown.
func (m *mailbox) del(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, fmt.Sprintf("%s/api/pair/%s", m.base, id), nil)
	if err != nil {
		return err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("pairing: mailbox delete: %w", err)
	}
	_ = resp.Body.Close()
	return nil
}
