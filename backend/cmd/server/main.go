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
	fmt.Fprintln(w, "Endpoints:")
	fmt.Fprintln(w, "  GET  /health                       - Health check")
	fmt.Fprintln(w, "  GET  /info                         - System information")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Identity (per-user mode):")
	fmt.Fprintln(w, "  POST /api/v1/identity/set          - Set user identity (triggers SDK restart)")
	fmt.Fprintln(w, "  GET  /api/v1/identity              - Get current identity status")
	fmt.Fprintln(w, "  DELETE /api/v1/identity             - Clear identity (logout/reset)")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Credentials:")
	fmt.Fprintln(w, "  GET  /api/v1/org                   - Organization info for frontend")
	fmt.Fprintln(w, "  GET  /api/v1/credentials           - List stored credentials")
	fmt.Fprintln(w, "  POST /api/v1/credentials           - Store credential from frontend")
	fmt.Fprintln(w, "  GET  /api/v1/credentials/{said}    - Get credential by SAID")
	fmt.Fprintln(w, "  POST /api/v1/credentials/validate  - Validate credential structure")
	fmt.Fprintln(w, "  GET  /api/v1/credentials/roles     - List available roles")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Sync:")
	fmt.Fprintln(w, "  POST /api/v1/sync/credentials      - Sync credentials from KERIA")
	fmt.Fprintln(w, "  POST /api/v1/sync/kel              - Sync KEL from KERIA")
	fmt.Fprintln(w, "  GET  /api/v1/community/members     - List community members")
	fmt.Fprintln(w, "  GET  /api/v1/community/credentials - List community-visible credentials")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Trust Graph:")
	fmt.Fprintln(w, "  GET  /api/v1/trust/graph           - Get trust graph (full or filtered)")
	fmt.Fprintln(w, "  GET  /api/v1/trust/score/{aid}     - Get trust score for an AID")
	fmt.Fprintln(w, "  GET  /api/v1/trust/scores          - Get top trust scores")
	fmt.Fprintln(w, "  GET  /api/v1/trust/summary         - Get trust graph summary")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Spaces (any-sync):")
	fmt.Fprintln(w, "  POST /api/v1/spaces/community                - Create community space")
	fmt.Fprintln(w, "  GET  /api/v1/spaces/community                - Get community space info")
	fmt.Fprintln(w, "  POST /api/v1/spaces/private                  - Create private space")
	fmt.Fprintln(w, "  POST /api/v1/spaces/community/invite         - Generate invite for user")
	fmt.Fprintln(w, "  POST /api/v1/spaces/community/join           - Join community with invite key")
	fmt.Fprintln(w, "  GET  /api/v1/spaces/community/verify-access  - Verify community access")
	fmt.Fprintln(w, "  GET  /api/v1/spaces/sync-status              - Check space sync readiness")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Invites:")
	fmt.Fprintln(w, "  POST /api/v1/invites/send-email       - Email invite code to user")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Notifications:")
	fmt.Fprintln(w, "  POST /api/v1/notifications/registration-submitted - Notify onboarding of new registration")
	fmt.Fprintln(w, "  POST /api/v1/notifications/registration-approved  - Notify applicant of approval")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Profiles & Types:")
	fmt.Fprintln(w, "  GET  /api/v1/types                    - List all type definitions")
	fmt.Fprintln(w, "  GET  /api/v1/types/{name}             - Get specific type definition")
	fmt.Fprintln(w, "  POST /api/v1/profiles                 - Create/update a profile object")
	fmt.Fprintln(w, "  GET  /api/v1/profiles/{type}          - List profiles of a type")
	fmt.Fprintln(w, "  GET  /api/v1/profiles/{type}/{id}     - Get specific profile")
	fmt.Fprintln(w, "  GET  /api/v1/profiles/me              - Get current user's profiles")
	fmt.Fprintln(w, "  POST /api/v1/profiles/init-member     - Initialize member profiles (admin)")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Notices (Activity):")
	fmt.Fprintln(w, "  POST /api/v1/notices                  - Create notice (draft or published)")
	fmt.Fprintln(w, "  GET  /api/v1/notices                  - List notices (?view=upcoming|current|past&type=event|update)")
	fmt.Fprintln(w, "  GET  /api/v1/notices/{id}             - Get single notice")
	fmt.Fprintln(w, "  POST /api/v1/notices/{id}/publish     - Publish a draft notice")
	fmt.Fprintln(w, "  POST /api/v1/notices/{id}/archive     - Archive a published notice")
	fmt.Fprintln(w, "  POST /api/v1/notices/{id}/rsvp        - Create/update RSVP")
	fmt.Fprintln(w, "  GET  /api/v1/notices/{id}/rsvp        - List RSVPs for notice")
	fmt.Fprintln(w, "  POST /api/v1/notices/{id}/ack         - Create acknowledgment")
	fmt.Fprintln(w, "  GET  /api/v1/notices/{id}/ack         - List acks for notice")
	fmt.Fprintln(w, "  POST /api/v1/notices/{id}/save        - Toggle save/pin")
	fmt.Fprintln(w, "  GET  /api/v1/notices/saved            - List saved notices")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Files:")
	fmt.Fprintln(w, "  POST /api/v1/files/upload             - Upload file (avatar)")
	fmt.Fprintln(w, "  GET  /api/v1/files/{ref}              - Download file by ref")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Events:")
	fmt.Fprintln(w, "  GET  /api/v1/events                   - SSE event stream")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Chat:")
	fmt.Fprintln(w, "  GET  /api/v1/chat/channels            - List chat channels")
	fmt.Fprintln(w, "  POST /api/v1/chat/channels            - Create channel (admin)")
	fmt.Fprintln(w, "  GET  /api/v1/chat/channels/{id}       - Get channel details")
	fmt.Fprintln(w, "  PUT  /api/v1/chat/channels/{id}       - Update channel (admin)")
	fmt.Fprintln(w, "  DELETE /api/v1/chat/channels/{id}     - Archive channel (admin)")
	fmt.Fprintln(w, "  GET  /api/v1/chat/channels/{id}/messages - List messages")
	fmt.Fprintln(w, "  POST /api/v1/chat/channels/{id}/messages - Send message")
	fmt.Fprintln(w, "  PUT  /api/v1/chat/messages/{id}       - Edit message (owner)")
	fmt.Fprintln(w, "  DELETE /api/v1/chat/messages/{id}     - Delete message (owner)")
	fmt.Fprintln(w, "  GET  /api/v1/chat/messages/{id}/thread - Get thread replies")
	fmt.Fprintln(w, "  POST /api/v1/chat/messages/{id}/reactions - Add reaction")
	fmt.Fprintln(w, "  DELETE /api/v1/chat/messages/{id}/reactions/{emoji} - Remove reaction")
	fmt.Fprintln(w, "  GET  /api/v1/chat/read-cursors      - Get read cursors")
	fmt.Fprintln(w, "  PUT  /api/v1/chat/read-cursors      - Update read cursor")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Contributions System:")
	fmt.Fprintln(w, "  GET  /api/v1/proposals                    - List proposals")
	fmt.Fprintln(w, "  POST /api/v1/proposals                    - Create proposal")
	fmt.Fprintln(w, "  GET  /api/v1/proposals/{id}               - Get proposal")
	fmt.Fprintln(w, "  POST /api/v1/proposals/{id}/transition    - Transition proposal status")
	fmt.Fprintln(w, "  POST /api/v1/proposals/{id}/endorse       - Endorse proposal")
	fmt.Fprintln(w, "  GET  /api/v1/proposals/{id}/endorsements  - List endorsements")
	fmt.Fprintln(w, "  GET  /api/v1/projects                     - List projects")
	fmt.Fprintln(w, "  POST /api/v1/projects                     - Create project")
	fmt.Fprintln(w, "  GET  /api/v1/projects/{id}                - Get project")
	fmt.Fprintln(w, "  PUT  /api/v1/projects/{id}                - Update project")
	fmt.Fprintln(w, "  DELETE /api/v1/projects/{id}              - Delete project")
	fmt.Fprintln(w, "  POST /api/v1/projects/{id}/link-proposal  - Link proposal to project")
	fmt.Fprintln(w, "  GET  /api/v1/decision-plans               - List decision plans")
	fmt.Fprintln(w, "  POST /api/v1/decision-plans               - Create decision plan")
	fmt.Fprintln(w, "  GET  /api/v1/decision-plans/{id}          - Get decision plan")
	fmt.Fprintln(w, "  POST /api/v1/decision-plans/{id}/transition - Transition decision plan")
	fmt.Fprintln(w, "  POST /api/v1/decision-plans/{id}/actions  - Add governance action")
	fmt.Fprintln(w, "  GET  /api/v1/implementation-plans         - List implementation plans")
	fmt.Fprintln(w, "  POST /api/v1/implementation-plans         - Create implementation plan")
	fmt.Fprintln(w, "  GET  /api/v1/implementation-plans/{id}    - Get implementation plan")
	fmt.Fprintln(w, "  POST /api/v1/implementation-plans/{id}/milestones - Add milestone")
	fmt.Fprintln(w, "  GET  /api/v1/contributions                - List contributions")
	fmt.Fprintln(w, "  POST /api/v1/contributions                - Create contribution")
	fmt.Fprintln(w, "  GET  /api/v1/contributions/{id}           - Get contribution")
	fmt.Fprintln(w, "  PUT  /api/v1/contributions/{id}           - Update contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/transition - Transition contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/register  - Register interest")
	fmt.Fprintln(w, "  GET  /api/v1/contributions/{id}/registrations - List registrations")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/assign    - Assign contributor")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/confirm   - Confirm contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/share     - Share contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/offer     - Offer contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/accept-offer - Accept offered contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/submit-evidence - Submit evidence")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/review    - Review contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/sign-off  - Sign off contribution")
	fmt.Fprintln(w, "  POST /api/v1/contributions/{id}/approve-sub - Approve sub-contribution")
	fmt.Fprintln(w, "  POST /api/v1/implementation-plans/{id}/sign-off - Sign off plan")
	fmt.Fprintln(w, "  GET  /api/v1/projects/{id}/contributions  - List project contributions")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  Org Config:")
	fmt.Fprintln(w, "  GET  /api/v1/org/config               - Get org configuration")
	fmt.Fprintln(w, "  POST /api/v1/org/config               - Save org configuration")
	fmt.Fprintln(w, "  GET  /api/v1/org/health               - Config service health")
	fmt.Fprintln(w)
}
