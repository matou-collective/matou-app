package email

import (
	"fmt"
	"net/smtp"
	"strings"

	"github.com/matou-dao/backend/internal/config"
)

// SendInviteRequest contains the data needed to send an invite email
type SendInviteRequest struct {
	To          string
	InviteCode  string
	InviterName string
	InviteeName string
}

// Sender handles sending emails via SMTP
type Sender struct {
	host     string
	port     int
	from     string
	fromName string
}

// NewSender creates a new email Sender from SMTP config
func NewSender(cfg config.SMTPConfig) *Sender {
	return &Sender{
		host:     cfg.Host,
		port:     cfg.Port,
		from:     cfg.From,
		fromName: cfg.FromName,
	}
}

// SendInvite sends an invite code email to the specified recipient
func (s *Sender) SendInvite(req SendInviteRequest) error {
	body, err := renderInviteTemplate(inviteTemplateData{
		InviterName: req.InviterName,
		InviteeName: req.InviteeName,
		InviteCode:  req.InviteCode,
	})
	if err != nil {
		return fmt.Errorf("rendering email template: %w", err)
	}

	msg := s.buildMIMEMessage(req.To, "Your MATOU invite code", body)

	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	// nil auth for local relay (Postfix container)
	if err := smtp.SendMail(addr, nil, s.from, []string{req.To}, []byte(msg)); err != nil {
		return fmt.Errorf("sending email: %w", err)
	}

	return nil
}

// buildMIMEMessage constructs a MIME email message with HTML content
func (s *Sender) buildMIMEMessage(to, subject, htmlBody string) string {
	var b strings.Builder

	fromHeader := fmt.Sprintf("%s <%s>", s.fromName, s.from)

	b.WriteString(fmt.Sprintf("From: %s\r\n", fromHeader))
	b.WriteString(fmt.Sprintf("To: %s\r\n", to))
	b.WriteString(fmt.Sprintf("Subject: %s\r\n", subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)

	return b.String()
}
