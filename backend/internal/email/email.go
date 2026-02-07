package email

import (
	"crypto/tls"
	"fmt"
	"html/template"
	"net"
	"net/smtp"
	"strings"
	"time"

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

// SendBookingConfirmation sends a booking confirmation email with calendar invite
func (s *Sender) SendBookingConfirmation(to, name string, startTime time.Time, dateTimeNZT, dateTimeLocal string) error {
	// Generate ICS content
	endTime := startTime.Add(30 * time.Minute) // 30-minute session
	icsContent := s.generateICSWithFrom(startTime, endTime, name, "invites@matou.nz")

	// Generate email body
	body, err := renderBookingTemplate(bookingTemplateData{
		Name:          name,
		DateTimeNZT:   dateTimeNZT,
		DateTimeLocal: dateTimeLocal,
		LogoURL:       s.logoURL,
		TextURL:       s.textURL,
	})
	if err != nil {
		return fmt.Errorf("rendering booking email template: %w", err)
	}

	recipients := []string{to, "contact@matou.nz"}
	toHeader := strings.Join(recipients, ", ")
	msg := s.buildMIMEMessageWithCalendarFrom(toHeader, "MATOU - Whakawhānaunga Session", body, icsContent, "invites@matou.nz")

	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	if err := s.sendMailFromMulti(addr, "invites@matou.nz", recipients, []byte(msg)); err != nil {
		return fmt.Errorf("sending email: %w", err)
	}

	return nil
}

// generateICS creates an ICS calendar event
func (s *Sender) generateICS(startTime, endTime time.Time, attendeeName string) string {
	return s.generateICSWithFrom(startTime, endTime, attendeeName, s.from)
}

// generateICSWithFrom creates an ICS calendar event with a specific organizer email
func (s *Sender) generateICSWithFrom(startTime, endTime time.Time, attendeeName, fromEmail string) string {
	var b strings.Builder

	// Format times in UTC for ICS
	dtStart := startTime.UTC().Format("20060102T150405Z")
	dtEnd := endTime.UTC().Format("20060102T150405Z")
	dtStamp := time.Now().UTC().Format("20060102T150405Z")
	uid := fmt.Sprintf("%d-booking@matou.nz", startTime.Unix())

	b.WriteString("BEGIN:VCALENDAR\r\n")
	b.WriteString("VERSION:2.0\r\n")
	b.WriteString("PRODID:-//MATOU//Booking//EN\r\n")
	b.WriteString("METHOD:REQUEST\r\n")
	b.WriteString("BEGIN:VEVENT\r\n")
	b.WriteString(fmt.Sprintf("UID:%s\r\n", uid))
	b.WriteString(fmt.Sprintf("DTSTAMP:%s\r\n", dtStamp))
	b.WriteString(fmt.Sprintf("DTSTART:%s\r\n", dtStart))
	b.WriteString(fmt.Sprintf("DTEND:%s\r\n", dtEnd))
	b.WriteString(fmt.Sprintf("SUMMARY:Whakawhānaunga Session - %s\r\n", attendeeName))
	b.WriteString("DESCRIPTION:A short call to introduce ourselves and get to know each other as part of the MATOU community onboarding process.\r\n")
	b.WriteString(fmt.Sprintf("ORGANIZER;CN=MATOU:mailto:%s\r\n", fromEmail))
	b.WriteString("LOCATION:https://meet.jit.si/matou-whakawhanaunga-session\r\n")
	b.WriteString("STATUS:CONFIRMED\r\n")
	b.WriteString("END:VEVENT\r\n")
	b.WriteString("END:VCALENDAR\r\n")

	return b.String()
}

// SendRegistrationNotificationRequest contains the data needed to notify onboarding of a new registration
type SendRegistrationNotificationRequest struct {
	ApplicantName    string
	ApplicantEmail   string
	ApplicantAid     string
	Bio              string
	Location         string
	JoinReason       string
	Interests        []string
	CustomInterests  string
	SubmittedAt      string
}

// SendRegistrationNotification sends a notification email to contact@matou.nz about a new registration
func (s *Sender) SendRegistrationNotification(req SendRegistrationNotificationRequest) error {
	body, err := renderRegistrationNotificationTemplate(registrationNotificationTemplateData{
		ApplicantName:   req.ApplicantName,
		ApplicantEmail:  req.ApplicantEmail,
		ApplicantAid:    req.ApplicantAid,
		Bio:             req.Bio,
		Location:        req.Location,
		JoinReason:      req.JoinReason,
		Interests:       formatInterests(req.Interests),
		CustomInterests: req.CustomInterests,
		SubmittedAt:     req.SubmittedAt,
		LogoURL:         s.logoURL,
		TextURL:         s.textURL,
	})
	if err != nil {
		return fmt.Errorf("rendering email template: %w", err)
	}

	subject := fmt.Sprintf("New Registration - %s", req.ApplicantName)
	msg := s.buildMIMEMessage("contact@matou.nz", subject, body)

	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	if err := s.sendMail(addr, "contact@matou.nz", []byte(msg)); err != nil {
		return fmt.Errorf("sending email: %w", err)
	}

	return nil
}

// SendApprovalNotificationRequest contains the data needed to notify an applicant of approval
type SendApprovalNotificationRequest struct {
	To            string
	ApplicantName string
}

// SendApprovalNotification sends an approval notification email to the applicant
func (s *Sender) SendApprovalNotification(req SendApprovalNotificationRequest) error {
	body, err := renderApprovalNotificationTemplate(approvalNotificationTemplateData{
		ApplicantName: req.ApplicantName,
		LogoURL:       s.logoURL,
		TextURL:       s.textURL,
	})
	if err != nil {
		return fmt.Errorf("rendering email template: %w", err)
	}

	msg := s.buildMIMEMessage(req.To, "Welcome to MATOU!", body)

	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	if err := s.sendMail(addr, req.To, []byte(msg)); err != nil {
		return fmt.Errorf("sending email: %w", err)
	}

	return nil
}

// sendMailFromMulti connects to the SMTP server and sends a single message to multiple recipients
func (s *Sender) sendMailFromMulti(addr, from string, recipients []string, msg []byte) error {
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

	if err := c.Mail(from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	for _, rcpt := range recipients {
		if err := c.Rcpt(rcpt); err != nil {
			return fmt.Errorf("RCPT TO %s: %w", rcpt, err)
		}
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

// sendMailFrom connects to the SMTP server and sends the message with a specific from address
func (s *Sender) sendMailFrom(addr, from, to string, msg []byte) error {
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

	if err := c.Mail(from); err != nil {
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

// buildMIMEMessageWithCalendarFrom constructs a MIME email with HTML content and ICS calendar attachment with custom from
func (s *Sender) buildMIMEMessageWithCalendarFrom(to, subject, htmlBody, icsContent, fromEmail string) string {
	var b strings.Builder
	boundary := "----=_Part_0_Calendar"

	fromHeader := fmt.Sprintf("%s <%s>", s.fromName, fromEmail)

	b.WriteString(fmt.Sprintf("From: %s\r\n", fromHeader))
	b.WriteString(fmt.Sprintf("To: %s\r\n", to))
	b.WriteString(fmt.Sprintf("Subject: %s\r\n", subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString(fmt.Sprintf("Content-Type: multipart/mixed; boundary=\"%s\"\r\n", boundary))
	b.WriteString("\r\n")

	// HTML part
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 7bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	b.WriteString("\r\n")

	// Calendar attachment
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: text/calendar; charset=\"UTF-8\"; method=REQUEST\r\n")
	b.WriteString("Content-Transfer-Encoding: 7bit\r\n")
	b.WriteString("Content-Disposition: attachment; filename=\"booking.ics\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(icsContent)
	b.WriteString("\r\n")

	// End boundary
	b.WriteString(fmt.Sprintf("--%s--\r\n", boundary))

	return b.String()
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
