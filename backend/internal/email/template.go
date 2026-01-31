package email

import (
	"bytes"
	"html/template"
)

type inviteTemplateData struct {
	InviterName string
	InviteeName string
	InviteCode  string
	LogoURL     template.URL
	TextURL     template.URL
}

const inviteEmailHTML = `<!DOCTYPE html>
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
                Kia ora{{if .InviteeName}} <strong>{{.InviteeName}}</strong>{{end}},
              </p>
              <p style="margin:0 0 24px; color:#374151; font-size:15px; line-height:1.6;">
                {{.InviterName}} has invited you to join MATOU. Follow these steps to get started:
              </p>
              <!-- Steps -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                <tr>
                  <td style="padding:8px 0; color:#374151; font-size:14px; line-height:1.5;">
                    <strong style="color:#1e5f74;">1.</strong> Download MATOU from <strong>matou.nz/download</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#374151; font-size:14px; line-height:1.5;">
                    <strong style="color:#1e5f74;">2.</strong> Open the app and select <strong>"I have an invite code"</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#374151; font-size:14px; line-height:1.5;">
                    <strong style="color:#1e5f74;">3.</strong> Enter the invite code below
                  </td>
                </tr>
              </table>
              <!-- Invite Code -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="background-color:#f0f9fa; border:1px solid #d1e7ea; border-radius:8px; padding:16px; text-align:center;">
                    <p style="margin:0 0 6px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Your Invite Code</p>
                    <p style="margin:0; font-family:'Courier New', Courier, monospace; font-size:15px; color:#1a1a1a; word-break:break-all; line-height:1.4;">{{.InviteCode}}</p>
                  </td>
                </tr>
              </table>
              <!-- Warning -->
              <p style="margin:20px 0 0; color:#9ca3af; font-size:13px; line-height:1.5;">
                This invite code is single-use{{if .InviteeName}} and has been created for <strong>{{.InviteeName}}</strong>{{end}}. It cannot be reused once claimed.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb; padding:20px 32px; border-top:1px solid #e5e7eb; text-align:center;">
              <p style="margin:0; color:#9ca3af; font-size:12px;">MATOU &mdash; Connection &vert; Collaboration &vert; Innovation </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

var inviteTemplate = template.Must(template.New("invite").Parse(inviteEmailHTML))

func renderInviteTemplate(data inviteTemplateData) (string, error) {
	var buf bytes.Buffer
	if err := inviteTemplate.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}
