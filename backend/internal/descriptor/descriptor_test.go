package descriptor

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The three GOLDEN documents are the fixtures idss's descriptor writer renders
// and checks in (idss internal/orgconfig/testdata) — one source, two repos
// (issue #533). The loader tests run against the very same bytes.
func readGolden(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	return data
}

func TestParseGoldenNoAnysync(t *testing.T) {
	doc, err := Parse(readGolden(t, "golden-no-anysync.json"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if doc.Version != "1.1" {
		t.Errorf("Version = %q, want 1.1", doc.Version)
	}
	if doc.BackendKind != BackendKindIDSS {
		t.Errorf("BackendKind = %q, want %q", doc.BackendKind, BackendKindIDSS)
	}
	if doc.Community == nil || doc.Community.Registry != "ERegistrySAID0000000000000000000000000000000" {
		t.Errorf("Community/registry not parsed: %+v", doc.Community)
	}
	if len(doc.Admins) != 1 || doc.Admins[0].Name != "Ben Tairea" {
		t.Errorf("Admins = %+v", doc.Admins)
	}
	// any-sync absent — nothing throws, the content layer is simply not there.
	if doc.HasContentLayer() {
		t.Error("HasContentLayer() = true, want false (no anysync block)")
	}
	// app absent until an app record reaches ready.
	if doc.App != nil {
		t.Errorf("App = %+v, want nil", doc.App)
	}
}

func TestParseGoldenAnysync(t *testing.T) {
	doc, err := Parse(readGolden(t, "golden-anysync.json"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !doc.HasContentLayer() {
		t.Error("HasContentLayer() = false, want true (anysync installed)")
	}
	if got := doc.Anysync["network_id"]; got != "N7whakatoheaAnysyncNetwork00000000000000000" {
		t.Errorf("anysync.network_id = %v", got)
	}
	if doc.App != nil {
		t.Errorf("App = %+v, want nil on the anysync variant", doc.App)
	}
}

func TestParseGoldenAppReady(t *testing.T) {
	doc, err := Parse(readGolden(t, "golden-app-ready.json"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !doc.HasContentLayer() {
		t.Error("HasContentLayer() = false, want true")
	}
	if doc.App == nil || doc.App.DownloadsURL != "https://coa.matou.nz/c/whakatohea/downloads" {
		t.Errorf("App = %+v", doc.App)
	}
}

func TestSchemaOOBIsFromBlock(t *testing.T) {
	doc, err := Parse(readGolden(t, "golden-no-anysync.json"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if doc.Schemas["membership"].SAID != "EMembershipSchemaSAID00000000000000000000000" {
		t.Errorf("membership SAID = %q", doc.Schemas["membership"].SAID)
	}
	got := doc.SchemaOOBIs()
	want := []string{
		"https://schema.whakatohea.idss.nz/oobi/ECommitteeSchemaSAID000000000000000000000000",
		"https://schema.whakatohea.idss.nz/oobi/EMembershipSchemaSAID00000000000000000000000",
	}
	if len(got) != len(want) {
		t.Fatalf("SchemaOOBIs() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("SchemaOOBIs()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestSigninURL(t *testing.T) {
	doc, err := Parse(readGolden(t, "golden-no-anysync.json"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := doc.SigninURL(); got != "https://whakatohea.idss.nz/authz/signin" {
		t.Errorf("SigninURL() = %q", got)
	}
}

func TestStackMismatchIsWarningNeverRefusal(t *testing.T) {
	doc, err := Parse(readGolden(t, "golden-no-anysync.json"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// A newer signify generation is a warning, not a parse failure.
	warnings := doc.StackMismatch(Stack{KERIA: "0.4.0", Signify: "0.3.0-rc2"})
	if len(warnings) != 1 {
		t.Fatalf("StackMismatch() = %v, want 1 warning", warnings)
	}
	// Aligned generations produce no warning.
	if w := doc.StackMismatch(Stack{KERIA: "0.4.0", Keripy: "1.2.6", Signify: "0.2.0-rc1"}); len(w) != 0 {
		t.Errorf("StackMismatch() = %v, want none", w)
	}
}

func TestToleratesRetiredDoorkeeperBlock(t *testing.T) {
	// A gateway that still serves the retired doorkeeper block must not trip
	// the loader; the block is simply not read (ADR 0236).
	raw := []byte(`{"version":"1.1","backend_kind":"idss","signin":{"url":"https://x/signin"},` +
		`"doorkeeper":{"aid":"EDoorkeeper","oobi":"https://x/oobi"}}`)
	doc, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if doc.SigninURL() != "https://x/signin" {
		t.Errorf("SigninURL() = %q", doc.SigninURL())
	}
}

func TestAcceptsAdditiveMinorBump(t *testing.T) {
	raw := []byte(`{"version":"1.9","backend_kind":"idss","futureBlock":{"a":1}}`)
	doc, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse of 1.9: %v", err)
	}
	if doc.Version != "1.9" {
		t.Errorf("Version = %q", doc.Version)
	}
}

func TestRefusesUnknownMajor(t *testing.T) {
	cases := []string{
		`{"version":"2.0","backend_kind":"idss"}`,
		`{"version":"","backend_kind":"idss"}`,
		`{"version":"garbage","backend_kind":"idss"}`,
	}
	for _, c := range cases {
		_, err := Parse([]byte(c))
		var uve *UnsupportedVersionError
		if !errors.As(err, &uve) {
			t.Errorf("Parse(%s) err = %v, want *UnsupportedVersionError", c, err)
		}
	}
}
