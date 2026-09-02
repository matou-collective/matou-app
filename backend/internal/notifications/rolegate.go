package notifications

import (
	"fmt"
	"log"
	"strings"
	"unicode"
)

// RoleGatedMembers wraps a ChannelMembers resolver and drops AIDs that may not
// read the channel. Chat channels are role-gated by their AllowedRoles list,
// enforced on every read in api.ChatHandler; the ACL that backs the wrapped
// resolver is community-wide, so without this filter a message in a
// stewards-only channel would wake every member of the community — telling
// people outside the gate that a channel they cannot open had traffic, and
// making their devices sync for nothing (docs/architecture/08-push-notifications.md §4).
//
// A channel with no AllowedRoles is open to everyone, and the wrapped resolver's
// list passes through untouched.
type RoleGatedMembers struct {
	members      ChannelMembers
	allowedRoles func(channelID string) ([]string, error)
	rolesForAID  func(aid string) ([]string, error)
}

// NewRoleGatedMembers builds a role-filtering ChannelMembers around members.
// allowedRoles resolves a channel's AllowedRoles gate (empty = open to all) and
// rolesForAID resolves the roles held by one AID — in app.go these are the chat
// channel record and the same ProfileRoleLookup the write rules use. If either
// resolver is nil the filter degrades to the unwrapped member list.
func NewRoleGatedMembers(
	members ChannelMembers,
	allowedRoles func(channelID string) ([]string, error),
	rolesForAID func(aid string) ([]string, error),
) *RoleGatedMembers {
	return &RoleGatedMembers{members: members, allowedRoles: allowedRoles, rolesForAID: rolesForAID}
}

// ChannelMembers implements the ChannelMembers interface, returning only those
// members of the channel's space whose roles satisfy its AllowedRoles gate.
//
// A gate that cannot be resolved is an error rather than an open channel: the
// safe failure for a privacy filter is no push at all (the recipients still get
// the message over SSE/sync when they open the app), never a push to everyone.
func (m *RoleGatedMembers) ChannelMembers(channelID string) ([]string, error) {
	if m.members == nil {
		return nil, nil
	}
	aids, err := m.members.ChannelMembers(channelID)
	if err != nil {
		return nil, err
	}
	if m.allowedRoles == nil || m.rolesForAID == nil {
		return aids, nil
	}

	allowed, err := m.allowedRoles(channelID)
	if err != nil {
		return nil, fmt.Errorf("resolving allowed roles for channel %s: %w", channelID, err)
	}
	if len(allowed) == 0 {
		return aids, nil // open channel: every member may read it
	}

	permitted := make([]string, 0, len(aids))
	for _, aid := range aids {
		roles, err := m.rolesForAID(aid)
		if err != nil {
			// Unknown roles means unknown eligibility — drop rather than leak.
			log.Printf("[Push] resolving roles for %s failed, skipping recipient: %v", aid, err)
			continue
		}
		if rolesSatisfyGate(allowed, roles) {
			permitted = append(permitted, aid)
		}
	}
	return permitted, nil
}

// rolesSatisfyGate reports whether any role held by a member satisfies a
// channel's AllowedRoles gate. Matching is case-insensitive like the read-side
// check (api.containsRole) but also word-aware, because the two sides are
// authored differently: the UI writes coarse gate labels ("steward", "admin")
// while resolved roles are contributions role IDs ("operations_steward"). A
// gate entry matches when all of its words appear in the held role, so
// "steward" admits an operations_steward while "admin" does not admit a
// plain member.
func rolesSatisfyGate(allowedRoles, heldRoles []string) bool {
	for _, allowed := range allowedRoles {
		want := roleWords(allowed)
		if len(want) == 0 {
			continue
		}
		for _, held := range heldRoles {
			if wordsContainAll(roleWords(held), want) {
				return true
			}
		}
	}
	return false
}

// roleWords lowercases a role label and splits it on any non-alphanumeric
// separator, so "Operations Steward", "operations_steward" and
// "operations-steward" all yield the same words.
func roleWords(role string) []string {
	return strings.FieldsFunc(strings.ToLower(role), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// wordsContainAll reports whether have contains every word in want.
func wordsContainAll(have, want []string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			if h == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
