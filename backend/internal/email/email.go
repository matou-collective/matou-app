package email

import (
	"crypto/tls"
	"fmt"
	"html/template"
	"net"
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
	host       string
	port       int
	from       string
	fromName   string
	logoURL    template.URL
	textURL    template.URL
}

// NewSender creates a new email Sender from SMTP config.
func NewSender(cfg config.SMTPConfig) *Sender {
	return &Sender{
		host:     cfg.Host,
		port:     cfg.Port,
		from:     cfg.From,
		fromName: cfg.FromName,
		logoURL:  template.URL(cfg.LogoURL),
		textURL:  template.URL(cfg.TextLogoURL),
	}
}

// SendInvite sends an invite code email to the specified recipient
func (s *Sender) SendInvite(req SendInviteRequest) error {
	body, err := renderInviteTemplate(inviteTemplateData{
		InviterName: req.InviterName,
		InviteeName: req.InviteeName,
		InviteCode:  req.InviteCode,
		LogoURL:     s.logoURL,
		TextURL:     s.textURL,
	})
	if err != nil {
		return fmt.Errorf("rendering email template: %w", err)
	}

	msg := s.buildMIMEMessage(req.To, "Your MATOU invite code", body)

	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	if err := s.sendMail(addr, req.To, []byte(msg)); err != nil {
		return fmt.Errorf("sending email: %w", err)
	}

	return nil
}

// sendMail connects to the SMTP server and sends the message.
// Uses STARTTLS with InsecureSkipVerify for local relay containers
// that present self-signed certificates.
func (s *Sender) sendMail(addr, to string, msg []byte) error {
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return fmt.Errorf("connecting to SMTP server: %w", err)
	}

	c, err := smtp.NewClient(conn, s.host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("creating SMTP client: %w", err)
	}
	defer c.Close()

	// STARTTLS with skip-verify for local relay's self-signed cert
	if ok, _ := c.Extension("STARTTLS"); ok {
		tlsConfig := &tls.Config{
			ServerName:         s.host,
			InsecureSkipVerify: true,
		}
		if err := c.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("STARTTLS: %w", err)
		}
	}

	if err := c.Mail(s.from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("RCPT TO: %w", err)
	}

	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("writing message: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("closing message: %w", err)
	}

	return c.Quit()
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
