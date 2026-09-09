// Command server runs the Matou backend as a standalone process. It resolves
// runtime configuration from the environment (app.OptionsFromEnv), hands the
// wiring to app.Start, prints the endpoint reference banner, then blocks until
// an interrupt triggers a graceful shutdown. All server wiring lives in
// internal/app so cmd/mobile can embed the same backend in-process.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/matou-dao/backend/internal/app"
)

// shutdownGrace bounds how long a graceful shutdown may take before the process
// exits regardless. Ctrl-C must return the shell within this window.
const shutdownGrace = 10 * time.Second

func main() {
	opts, err := app.OptionsFromEnv()
	if err != nil {
		log.Fatalf("Failed to resolve options: %v", err)
	}

	// Interrupt/terminate cancels the context, unblocking the wait below and
	// driving App.Shutdown so deferred closers (sync worker, store, SDK client)
	// run in reverse before the process exits.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	application, err := app.Start(ctx, opts)
	if err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}

	// Endpoint reference banner lives here (not in app.Start) so an embedded
	// backend stays silent; it is gated on the same PrintBanner flag.
	if opts.PrintBanner {
		printEndpoints(os.Stdout)
	}

	// Wait for either the server to stop on its own (fatal serve error) or an
	// interrupt signal. Serve errors are fatal; a signal triggers graceful
	// shutdown.
	serveErr := make(chan error, 1)
	go func() { serveErr <- application.Wait() }()

	select {
	case err := <-serveErr:
		if err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	case <-ctx.Done():
		stop() // restore default signal handling so a second Ctrl-C force-quits
		fmt.Println("\nShutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := application.Shutdown(shutdownCtx); err != nil {
			log.Fatalf("Shutdown failed: %v", err)
		}
	}
}

// printEndpoints writes the human-readable API endpoint reference. It is purely
// informational and matches the banner the standalone server has always shown.
func printEndpoints(w io.Writer) {
	_, _ = fmt.Fprintln(w, "Endpoints:")
	_, _ = fmt.Fprintln(w, "  GET  /health                       - Health check")
	_, _ = fmt.Fprintln(w, "  GET  /info                         - System information")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Identity (per-user mode):")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/identity/set          - Set user identity (triggers SDK restart)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/identity              - Get current identity status")
	_, _ = fmt.Fprintln(w, "  DELETE /api/v1/identity             - Clear identity (logout/reset)")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Credentials:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/org                   - Organization info for frontend")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/credentials           - List stored credentials")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/credentials           - Store credential from frontend")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/credentials/{said}    - Get credential by SAID")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/credentials/validate  - Validate credential structure")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/credentials/roles     - List available roles")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Sync:")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/sync/credentials      - Sync credentials from KERIA")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/sync/kel              - Sync KEL from KERIA")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/community/members     - List community members")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/community/credentials - List community-visible credentials")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Trust Graph:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/trust/graph           - Get trust graph (full or filtered)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/trust/score/{aid}     - Get trust score for an AID")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/trust/scores          - Get top trust scores")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/trust/summary         - Get trust graph summary")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Spaces (any-sync):")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/spaces/community                - Create community space")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/spaces/community                - Get community space info")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/spaces/private                  - Create private space")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/spaces/community/invite         - Generate invite for user")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/spaces/community/join           - Join community with invite key")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/spaces/community/verify-access  - Verify community access")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/spaces/sync-status              - Check space sync readiness")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Invites:")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/invites/send-email       - Email invite code to user")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Notifications:")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notifications/registration-submitted - Notify onboarding of new registration")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notifications/registration-approved  - Notify applicant of approval")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Profiles & Types:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/types                    - List all type definitions")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/types/{name}             - Get specific type definition")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/profiles                 - Create/update a profile object")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/profiles/{type}          - List profiles of a type")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/profiles/{type}/{id}     - Get specific profile")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/profiles/me              - Get current user's profiles")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/profiles/init-member     - Initialize member profiles (admin)")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Notices (Activity):")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notices                  - Create notice (draft or published)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/notices                  - List notices (?view=upcoming|current|past&type=event|update)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/notices/{id}             - Get single notice")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notices/{id}/publish     - Publish a draft notice")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notices/{id}/archive     - Archive a published notice")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notices/{id}/rsvp        - Create/update RSVP")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/notices/{id}/rsvp        - List RSVPs for notice")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notices/{id}/ack         - Create acknowledgment")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/notices/{id}/ack         - List acks for notice")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/notices/{id}/save        - Toggle save/pin")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/notices/saved            - List saved notices")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Files:")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/files/upload             - Upload file (avatar)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/files/{ref}              - Download file by ref")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Events:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/events                   - SSE event stream")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Chat:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/chat/channels            - List chat channels")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/chat/channels            - Create channel (admin)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/chat/channels/{id}       - Get channel details")
	_, _ = fmt.Fprintln(w, "  PUT  /api/v1/chat/channels/{id}       - Update channel (admin)")
	_, _ = fmt.Fprintln(w, "  DELETE /api/v1/chat/channels/{id}     - Archive channel (admin)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/chat/channels/{id}/messages - List messages")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/chat/channels/{id}/messages - Send message")
	_, _ = fmt.Fprintln(w, "  PUT  /api/v1/chat/messages/{id}       - Edit message (owner)")
	_, _ = fmt.Fprintln(w, "  DELETE /api/v1/chat/messages/{id}     - Delete message (owner)")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/chat/messages/{id}/thread - Get thread replies")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/chat/messages/{id}/reactions - Add reaction")
	_, _ = fmt.Fprintln(w, "  DELETE /api/v1/chat/messages/{id}/reactions/{emoji} - Remove reaction")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/chat/read-cursors      - Get read cursors")
	_, _ = fmt.Fprintln(w, "  PUT  /api/v1/chat/read-cursors      - Update read cursor")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Contributions System:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/proposals                    - List proposals")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/proposals                    - Create proposal")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/proposals/{id}               - Get proposal")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/proposals/{id}/transition    - Transition proposal status")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/proposals/{id}/endorse       - Endorse proposal")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/proposals/{id}/endorsements  - List endorsements")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/projects                     - List projects")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/projects                     - Create project")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/projects/{id}                - Get project")
	_, _ = fmt.Fprintln(w, "  PUT  /api/v1/projects/{id}                - Update project")
	_, _ = fmt.Fprintln(w, "  DELETE /api/v1/projects/{id}              - Delete project")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/projects/{id}/link-proposal  - Link proposal to project")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/decision-plans               - List decision plans")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/decision-plans               - Create decision plan")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/decision-plans/{id}          - Get decision plan")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/decision-plans/{id}/transition - Transition decision plan")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/decision-plans/{id}/actions  - Add governance action")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/implementation-plans         - List implementation plans")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/implementation-plans         - Create implementation plan")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/implementation-plans/{id}    - Get implementation plan")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/implementation-plans/{id}/milestones - Add milestone")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/contributions                - List contributions")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions                - Create contribution")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/contributions/{id}           - Get contribution")
	_, _ = fmt.Fprintln(w, "  PUT  /api/v1/contributions/{id}           - Update contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/transition - Transition contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/register  - Register interest")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/contributions/{id}/registrations - List registrations")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/assign    - Assign contributor")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/confirm   - Confirm contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/share     - Share contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/offer     - Offer contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/accept-offer - Accept offered contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/submit-evidence - Submit evidence")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/review    - Review contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/sign-off  - Sign off contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/approve-sub - Approve sub-contribution")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/implementation-plans/{id}/sign-off - Sign off plan")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/projects/{id}/contributions  - List project contributions")
	_, _ = fmt.Fprintln(w)
	_, _ = fmt.Fprintln(w, "  Org Config:")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/org/config               - Get org configuration")
	_, _ = fmt.Fprintln(w, "  POST /api/v1/org/config               - Save org configuration")
	_, _ = fmt.Fprintln(w, "  GET  /api/v1/org/health               - Config service health")
	_, _ = fmt.Fprintln(w)
}
