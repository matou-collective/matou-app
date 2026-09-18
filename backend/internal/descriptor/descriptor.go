// Package descriptor parses the community backend descriptor — the one
// document a Coa build reads at boot (GET <url>/api/client-config) and the
// gateway's config server serves (ADR 0226). It is the reader's half of the
// contract idss's internal/orgconfig writes: one source, two repos, the same
// golden documents.
//
// On an IDSS gateway the document is the 1.1 descriptor rendered from the
// roster — one community witness, the gateway's own schema OOBIs, a signin
// block where doorkeeper used to be, and, until the operator designs an app or
// any-sync is installed, no `anysync` and no `app` key at all. This package
// tolerates every optional block and refuses ONLY an unknown `version` major:
// a `stack` mismatch (KERIA / keripy / signify generations) is a diagnostics
// warning, never a refusal.
package descriptor

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// KnownMajor is the descriptor major this build understands. The version is an
// additive minor bump (ADR 0226 decision 5): every new block is optional, so a
// newer 1.x document keeps working and this build simply ignores blocks it does
// not read. The ONLY hard refusal is a major it does not know.
const KnownMajor = 1

// BackendKindIDSS marks a gateway-served descriptor (ADR 0226 decision 5).
const BackendKindIDSS = "idss"

// Document is the whole community backend descriptor. Every block below the two
// fixed leads is a rendering of the roster, the schema set, the stack pins and
// the apex; `app` and `anysync` are omitted until they exist. The retired
// `doorkeeper` block (ADR 0236) is not modelled and is simply not read.
type Document struct {
	Version     string            `json:"version"`
	BackendKind string            `json:"backend_kind"`
	Community   *Community        `json:"community,omitempty"`
	Admins      []Steward         `json:"admins,omitempty"`
	APIURL      string            `json:"api_url,omitempty"`
	Schemas     map[string]Schema `json:"schemas,omitempty"`
	Boot        *Boot             `json:"boot,omitempty"`
	Signin      *Signin           `json:"signin,omitempty"`
	Stack       *Stack            `json:"stack,omitempty"`
	// App is present only once the community app record reaches ready.
	App *App `json:"app,omitempty"`
	// Anysync is present only when any-sync is installed on the gateway (ADR
	// 0226 decision 8). A passthrough — its shape is matou-infrastructure's,
	// not ours — so it stays a raw object. Absent means no content layer.
	Anysync map[string]any `json:"anysync,omitempty"`
}

// Community is the community identity block (ADR 0226 decision 5, ADR 0235).
type Community struct {
	Name     string `json:"name"`
	Slug     string `json:"slug"`
	AID      string `json:"aid"`
	OOBI     string `json:"oobi"`
	Registry string `json:"registry"`
}

// Steward is one active operator as an admin entry (ADR 0235).
type Steward struct {
	AID  string `json:"aid"`
	Name string `json:"name,omitempty"`
	OOBI string `json:"oobi"`
}

// Schema is one credential kind's SAID and public OOBI (ADR 0226 decision 5).
type Schema struct {
	SAID string `json:"said"`
	OOBI string `json:"oobi"`
}

// Boot is the wallet's boot posture (ADR 0226 decision 5, ADR 0235).
type Boot struct {
	Gated   bool   `json:"gated"`
	JoinURL string `json:"join_url"`
}

// Signin is the bridge's sign-in endpoint — the home community's door (ADR 0236).
type Signin struct {
	URL string `json:"url"`
}

// Stack pins the gateway's KERI generations (ADR 0226 decision 5).
type Stack struct {
	KERIA   string `json:"keria"`
	Keripy  string `json:"keripy,omitempty"`
	Signify string `json:"signify,omitempty"`
}

// App is the community app pointer (ADR 0226 decision 5).
type App struct {
	Name         string   `json:"name"`
	DownloadsURL string   `json:"downloads_url"`
	Platforms    []string `json:"platforms,omitempty"`
}

// UnsupportedVersionError is returned when the descriptor's `version` major is
// one this build does not know — the ONLY hard refusal (ADR 0226 decision 5).
type UnsupportedVersionError struct {
	Version string
	Major   int
}

func (e *UnsupportedVersionError) Error() string {
	return fmt.Sprintf(
		"community backend descriptor version %q (major %d) is newer than this build understands (major %d)",
		e.Version, e.Major, KnownMajor,
	)
}

// Parse decodes and validates a community backend descriptor. It refuses ONLY
// an unknown `version` major (an absent or unparseable version is treated as
// such, returning *UnsupportedVersionError); every optional block — an absent
// `anysync`, `app`, `signin`, or the retired `doorkeeper` — is tolerated.
func Parse(data []byte) (*Document, error) {
	var doc Document
	dec := json.NewDecoder(strings.NewReader(string(data)))
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("parse community backend descriptor: %w", err)
	}

	major := versionMajor(doc.Version)
	if major < 0 || major > KnownMajor {
		return nil, &UnsupportedVersionError{Version: doc.Version, Major: major}
	}
	return &doc, nil
}

// versionMajor parses the leading integer of a `major.minor` version string,
// returning -1 when it cannot be parsed (treated as an unknown major).
func versionMajor(version string) int {
	head := strings.SplitN(strings.TrimSpace(version), ".", 2)[0]
	n, err := strconv.Atoi(head)
	if err != nil {
		return -1
	}
	return n
}

// HasContentLayer reports whether any-sync is installed on the gateway. When
// false, the wallet's content surfaces render their empty state (ADR 0226
// decision 8) and nothing throws.
func (d *Document) HasContentLayer() bool {
	return len(d.Anysync) > 0
}

// SchemaOOBIs returns the schema OOBIs the wallet resolves, taken from the
// document's `schemas` block rather than a built-in list (ADR 0226 decision 5).
// The result is sorted for a stable order.
func (d *Document) SchemaOOBIs() []string {
	oobis := make([]string, 0, len(d.Schemas))
	for _, s := range d.Schemas {
		if s.OOBI != "" {
			oobis = append(oobis, s.OOBI)
		}
	}
	sort.Strings(oobis)
	return oobis
}

// SigninURL returns the home community's sign-in door, or "" when the document
// names none (ADR 0236).
func (d *Document) SigninURL() string {
	if d.Signin == nil {
		return ""
	}
	return d.Signin.URL
}

// StackMismatch describes any KERI-generation mismatch between the gateway's
// pinned `stack` and the wallet's own generations. Per ADR 0226 decision 5 this
// is a diagnostics warning, NEVER a refusal — it makes the crossing visible
// rather than silent. Returns one line per differing generation.
func (d *Document) StackMismatch(wallet Stack) []string {
	var warnings []string
	if d.Stack == nil {
		return warnings
	}
	check := func(label, gateway, mine string) {
		if gateway != "" && mine != "" && gateway != mine {
			warnings = append(warnings, fmt.Sprintf("%s: gateway %s, wallet %s", label, gateway, mine))
		}
	}
	check("KERIA", d.Stack.KERIA, wallet.KERIA)
	check("keripy", d.Stack.Keripy, wallet.Keripy)
	check("signify", d.Stack.Signify, wallet.Signify)
	return warnings
}
