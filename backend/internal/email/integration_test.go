//go:build send_email

package email

import (
	"os"
	"testing"

	"github.com/matou-dao/backend/internal/config"
)

// Run with: go test -tags=send_email -v ./internal/email/...
//
// Requires the Postfix container to be running:
//   cd infrastructure/keri && make up
//
// This uses a dedicated build tag (send_email) rather than "integration"
// to avoid accidentally sending real emails when running other integration tests.

func TestSendInviteEmail(t *testing.T) {
	smtpHost := os.Getenv("MATOU_SMTP_HOST")
	if smtpHost == "" {
		smtpHost = "localhost"
	}
	smtpPort := 2525

	sender := NewSender(config.SMTPConfig{
		Host:        smtpHost,
		Port:        smtpPort,
		From:        "invites@matou.nz",
		FromName:    "MATOU",
		LogoURL:     "https://i.imgur.com/zi01gTx.png",
		TextLogoURL: "https://i.imgur.com/1D3iLWa.png",
	})

	err := sender.SendInvite(SendInviteRequest{
		To:          "jamin.tairea@gmail.com",
		InviteCode:  "abandon math ivory loop gallery brave whisper column oxygen planet surface absorb",
		InviterName: "Jamin Tairea",
		InviteeName: "Test User",
	})
	if err != nil {
		t.Fatalf("SendInvite failed: %v", err)
	}

	t.Log("Email sent successfully to jamin.tairea@gmail.com")
}
