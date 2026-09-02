package notifications

import (
	"errors"
	"reflect"
	"testing"
)

// roles mirrors what ProfileRoleLookup returns for each AID in app.go: the
// contributions role IDs a member's profile role maps to.
var testMemberRoles = map[string][]string{
	"aid-founder":  {"member", "contributor", "founding_member", "operations_steward", "project_steward", "project_lead"},
	"aid-steward":  {"member", "contributor", "community_steward", "project_steward"},
	"aid-member":   {"member"},
	"aid-contribu": {"member", "contributor"},
}

func rolesForTestAID(aid string) ([]string, error) {
	roles, ok := testMemberRoles[aid]
	if !ok {
		return nil, errors.New("no profile for " + aid)
	}
	return roles, nil
}

func gateOf(roles ...string) func(string) ([]string, error) {
	return func(string) ([]string, error) { return roles, nil }
}

// TestRoleGatedMembers_GatedChannelDropsOutsiders is the core case: a
// stewards-only channel must resolve only the members whose roles satisfy the
// gate. Without the filter every community member is returned and gets woken
// for a channel they cannot open.
func TestRoleGatedMembers_GatedChannelDropsOutsiders(t *testing.T) {
	all := membersStub{members: []string{"aid-founder", "aid-steward", "aid-member", "aid-contribu"}}
	m := NewRoleGatedMembers(all, gateOf("admin", "steward"), rolesForTestAID)

	got, err := m.ChannelMembers("chan-stewards")
	if err != nil {
		t.Fatalf("ChannelMembers: %v", err)
	}
	want := []string{"aid-founder", "aid-steward"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("recipients = %v, want %v", got, want)
	}
}

// TestRoleGatedMembers_OpenChannelUnchanged: no AllowedRoles means open to all,
// so behaviour is identical to the unwrapped resolver.
func TestRoleGatedMembers_OpenChannelUnchanged(t *testing.T) {
	all := membersStub{members: []string{"aid-founder", "aid-member"}}
	m := NewRoleGatedMembers(all, gateOf(), rolesForTestAID)

	got, err := m.ChannelMembers("chan-general")
	if err != nil {
		t.Fatalf("ChannelMembers: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"aid-founder", "aid-member"}) {
		t.Fatalf("recipients = %v, want the full member list", got)
	}
}

// TestRoleGatedMembers_TitleCaseGate: gates authored in Title Case with spaces
// match the underscored role IDs.
func TestRoleGatedMembers_TitleCaseGate(t *testing.T) {
	all := membersStub{members: []string{"aid-founder", "aid-steward", "aid-member"}}
	m := NewRoleGatedMembers(all, gateOf("Founding Member"), rolesForTestAID)

	got, err := m.ChannelMembers("chan-founders")
	if err != nil {
		t.Fatalf("ChannelMembers: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"aid-founder"}) {
		t.Fatalf("recipients = %v, want [aid-founder]", got)
	}
}

// TestRoleGatedMembers_UnknownRolesDropped: an AID whose roles cannot be
// resolved is dropped, never leaked into a gated channel's recipients.
func TestRoleGatedMembers_UnknownRolesDropped(t *testing.T) {
	all := membersStub{members: []string{"aid-steward", "aid-unknown"}}
	m := NewRoleGatedMembers(all, gateOf("steward"), rolesForTestAID)

	got, err := m.ChannelMembers("chan-stewards")
	if err != nil {
		t.Fatalf("ChannelMembers: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"aid-steward"}) {
		t.Fatalf("recipients = %v, want [aid-steward]", got)
	}
}

// TestRoleGatedMembers_GateErrorIsFatalToThePush: an unresolvable gate must
// error (PushSender then logs and sends nothing) rather than fall open.
func TestRoleGatedMembers_GateErrorIsFatalToThePush(t *testing.T) {
	all := membersStub{members: []string{"aid-founder", "aid-member"}}
	m := NewRoleGatedMembers(all, func(string) ([]string, error) {
		return nil, errors.New("channel not found")
	}, rolesForTestAID)

	got, err := m.ChannelMembers("chan-missing")
	if err == nil {
		t.Fatalf("expected an error, got recipients %v", got)
	}
	if got != nil {
		t.Fatalf("recipients = %v, want none on gate-resolution failure", got)
	}
}

// TestRoleGatedMembers_EndToEndWithPushSender proves the wiring app.go uses:
// the relay is asked to wake only the permitted members, minus the sender.
func TestRoleGatedMembers_EndToEndWithPushSender(t *testing.T) {
	relay := &stubRelay{}
	all := membersStub{members: []string{"aid-founder", "aid-steward", "aid-member", "aid-contribu"}}
	gated := NewRoleGatedMembers(all, gateOf("steward"), rolesForTestAID)

	s := NewPushSender(relay, gated)
	s.Broadcast(msgEvent("chan-stewards", "aid-founder"))

	call, ok := relay.lastCall()
	if !ok {
		t.Fatal("relay was not called")
	}
	if !reflect.DeepEqual(call.recipients, []string{"aid-steward"}) {
		t.Fatalf("recipients = %v, want [aid-steward] (founder is the sender, member/contributor are outside the gate)", call.recipients)
	}
}
