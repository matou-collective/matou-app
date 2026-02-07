package email

import (
	"bytes"
	"html/template"
	"strings"
)

// Registration notification template (sent to contact@matou.nz)

type registrationNotificationTemplateData struct {
	ApplicantName string
	ApplicantEmail string
	ApplicantAid  string
	Bio           string
	Location      string
	JoinReason    string
	Interests     string
	CustomInterests string
	SubmittedAt   string
	LogoURL       template.URL
	TextURL       template.URL
}

const registrationNotificationHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background-color:#1e5f74; padding:24px 32px; text-align:center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                <tr>
                  <td style="vertical-align:middle; padding-right:12px;">
                    <img src="{{.LogoURL}}" alt="" width="80" height="40" style="display:block; border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <img src="{{.TextURL}}" alt="MATOU" width="140" height="40" style="display:block; border:0;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 20px; color:#1a1a1a; font-size:16px; line-height:1.5;">
                <strong>New Registration Submitted</strong>
              </p>
              <p style="margin:0 0 16px; color:#374151; font-size:15px; line-height:1.6;">
                A new member has submitted a registration for review.
              </p>
              <!-- Applicant Details -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="background-color:#f0f9fa; border:1px solid #d1e7ea; border-radius:8px; padding:20px;">
                    <p style="margin:0 0 12px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Applicant Details</p>
                    <p style="margin:0 0 8px; color:#1a1a1a; font-size:15px; line-height:1.5;">
                      <strong>Name:</strong> {{.ApplicantName}}
                    </p>
                    {{if .ApplicantEmail}}<p style="margin:0 0 8px; color:#1a1a1a; font-size:15px; line-height:1.5;">
                      <strong>Email:</strong> {{.ApplicantEmail}}
                    </p>{{end}}
                    {{if .Location}}<p style="margin:0 0 8px; color:#1a1a1a; font-size:15px; line-height:1.5;">
                      <strong>Location:</strong> {{.Location}}
                    </p>{{end}}
                    <p style="margin:0 0 8px; color:#1a1a1a; font-size:15px; line-height:1.5;">
                      <strong>AID:</strong> <span style="font-family:'Courier New',Courier,monospace; font-size:13px; word-break:break-all;">{{.ApplicantAid}}</span>
                    </p>
                    {{if .SubmittedAt}}<p style="margin:0; color:#1a1a1a; font-size:15px; line-height:1.5;">
                      <strong>Submitted:</strong> {{.SubmittedAt}}
                    </p>{{end}}
                  </td>
                </tr>
              </table>
              {{if .Bio}}
              <!-- Bio -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:16px;">
                <tr>
                  <td style="background-color:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
                    <p style="margin:0 0 6px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Bio</p>
                    <p style="margin:0; color:#374151; font-size:14px; line-height:1.6;">{{.Bio}}</p>
                  </td>
                </tr>
              </table>
              {{end}}
              {{if .JoinReason}}
              <!-- Join Reason -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:16px;">
                <tr>
                  <td style="background-color:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
                    <p style="margin:0 0 6px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Reason for Joining</p>
                    <p style="margin:0; color:#374151; font-size:14px; line-height:1.6;">{{.JoinReason}}</p>
                  </td>
                </tr>
              </table>
              {{end}}
              {{if .Interests}}
              <!-- Interests -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:16px;">
                <tr>
                  <td style="background-color:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
                    <p style="margin:0 0 6px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Interests</p>
                    <p style="margin:0; color:#374151; font-size:14px; line-height:1.6;">{{.Interests}}</p>
                    {{if .CustomInterests}}<p style="margin:6px 0 0; color:#374151; font-size:14px; line-height:1.6;"><em>Other: {{.CustomInterests}}</em></p>{{end}}
                  </td>
                </tr>
              </table>
              {{end}}
              <!-- Action -->
              <p style="margin:24px 0 0; color:#374151; font-size:14px; line-height:1.6;">
                Open the MATOU admin dashboard to review this registration.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb; padding:20px 32px; border-top:1px solid #e5e7eb; text-align:center;">
              <p style="margin:0; color:#9ca3af; font-size:12px;">MATOU &mdash; Connection &vert; Collaboration &vert; Innovation</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

var registrationNotificationTemplate = template.Must(template.New("registrationNotification").Parse(registrationNotificationHTML))

func renderRegistrationNotificationTemplate(data registrationNotificationTemplateData) (string, error) {
	var buf bytes.Buffer
	if err := registrationNotificationTemplate.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// formatInterests joins a slice of interests into a comma-separated string
func formatInterests(interests []string) string {
	return strings.Join(interests, ", ")
}

// Approval notification template (sent to registrant)

type approvalNotificationTemplateData struct {
	ApplicantName string
	LogoURL       template.URL
	TextURL       template.URL
}

const approvalNotificationHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background-color:#1e5f74; padding:24px 32px; text-align:center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                <tr>
                  <td style="vertical-align:middle; padding-right:12px;">
                    <img src="{{.LogoURL}}" alt="" width="80" height="40" style="display:block; border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <img src="{{.TextURL}}" alt="MATOU" width="140" height="40" style="display:block; border:0;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 20px; color:#1a1a1a; font-size:16px; line-height:1.5;">
                Kia ora <strong>{{.ApplicantName}}</strong>,
              </p>
              <p style="margin:0 0 24px; color:#374151; font-size:15px; line-height:1.6;">
                Congratulations! Your registration has been approved and you are now a member of the MATOU community.
              </p>
              <!-- Next Steps -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="background-color:#f0f9fa; border:1px solid #d1e7ea; border-radius:8px; padding:20px;">
                    <p style="margin:0 0 12px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Next Steps</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding:6px 0; color:#374151; font-size:14px; line-height:1.5;">
                          <strong style="color:#1e5f74;">1.</strong> Open the MATOU app
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0; color:#374151; font-size:14px; line-height:1.5;">
                          <strong style="color:#1e5f74;">2.</strong> Your membership credential will arrive automatically
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0; color:#374151; font-size:14px; line-height:1.5;">
                          <strong style="color:#1e5f74;">3.</strong> Once received, you'll have full access to the community
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0; color:#374151; font-size:14px; line-height:1.6;">
                If you have any questions, reach out to us at <a href="mailto:contact@matou.nz" style="color:#1e5f74;">contact@matou.nz</a>.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb; padding:20px 32px; border-top:1px solid #e5e7eb; text-align:center;">
              <p style="margin:0; color:#9ca3af; font-size:12px;">MATOU &mdash; Connection &vert; Collaboration &vert; Innovation</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

var approvalNotificationTemplate = template.Must(template.New("approvalNotification").Parse(approvalNotificationHTML))

func renderApprovalNotificationTemplate(data approvalNotificationTemplateData) (string, error) {
	var buf bytes.Buffer
	if err := approvalNotificationTemplate.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}
