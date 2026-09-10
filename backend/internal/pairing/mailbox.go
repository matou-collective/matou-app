package pairing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
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

// Retry pacing for transient mailbox answers. The config server rate-limits
// per client IP (60 requests / 5 min, 429 + Retry-After), answers 503 when its
// record store is full, and a reverse proxy may add 502/504. None of those mean
// the pairing is gone, so the session waits and retries instead of failing.
const (
	defaultRetryDelay = 2 * time.Second
	maxRetryDelay     = 30 * time.Second
)

// retryError says the mailbox call did not happen (rate limit, capacity,
// gateway error, client timeout) and may be retried after the given delay.
type retryError struct {
	status int
	after  time.Duration
}

func (e *retryError) Error() string {
	if e.status == 0 {
		return "pairing: mailbox timed out (retry)"
	}
	return fmt.Sprintf("pairing: mailbox status %d (retry after %s)", e.status, e.after)
}

// retryAfter parses the Retry-After header (seconds) into a bounded delay.
func retryAfter(resp *http.Response) time.Duration {
	if resp == nil {
		return defaultRetryDelay
	}
	secs, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After")))
	if err != nil || secs <= 0 {
		return defaultRetryDelay
	}
	d := time.Duration(secs) * time.Second
	if d > maxRetryDelay {
		d = maxRetryDelay
	}
	return d
}

// classifyStatus maps a transient status to a retryError, else nil.
func classifyStatus(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusTooManyRequests, http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
		return &retryError{status: resp.StatusCode, after: retryAfter(resp)}
	}
	return nil
}

// isTimeout reports whether a transport error is a client-side timeout (the
// long-poll ran past http.Client.Timeout), which is safe to retry for a read.
func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

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
		// 429/503/502/504: the server did not store the blob (its rate-limit
		// and capacity checks run before the store), so a retry is safe.
		if rerr := classifyStatus(resp); rerr != nil {
			return rerr
		}
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
		if ctx.Err() == nil && isTimeout(err) {
			// The long-poll outlived the client timeout (slow link); the
			// server hands a consumed blob back when the reader is gone, so
			// polling again is safe.
			return nil, &retryError{after: time.Second}
		}
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
		if rerr := classifyStatus(resp); rerr != nil {
			return nil, rerr
		}
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
