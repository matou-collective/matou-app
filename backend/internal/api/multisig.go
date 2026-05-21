package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
)

// MultisigHandler handles cross-client coordination signals for the
// member-to-admin multisig upgrade flow. See MULTISIG-POC-FINDINGS.md item #4:
// when admin pre-rotates their master AID, the member's KERIA must learn
// admin's new key state BEFORE the /multisig/rot EXN arrives. The POC does
// this via direct cross-client `keyStates().query()`. In production admin and
// member are in separate browsers, so we propagate the rotation signal via
// an any-sync object in the community space; tree_listener.go emits an SSE
// event when the object lands; the member's frontend handler then calls
// keyStates().query() locally and posts an ack object back.
type MultisigHandler struct {
	spaceManager *anysync.SpaceManager
}

// NewMultisigHandler constructs a MultisigHandler.
func NewMultisigHandler(spaceManager *anysync.SpaceManager) *MultisigHandler {
	return &MultisigHandler{spaceManager: spaceManager}
}

// RegisterRoutes registers multisig coordination endpoints on the mux.
func (h *MultisigHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/multisig/rotation-signal", CORSHandler(h.HandleRotationSignal))
	mux.HandleFunc("/api/v1/multisig/rotation-ack", CORSHandler(h.HandleRotationAck))
}

// RotationSignalRequest is the body for POST /api/v1/multisig/rotation-signal.
type RotationSignalRequest struct {
	AdminAid        string `json:"adminAid"`
	AdminSn         string `json:"adminSn"`
	TargetMemberAid string `json:"targetMemberAid"`
	Round           string `json:"round"`
	GroupAid        string `json:"groupAid"`
}

// HandleRotationSignal writes a MultisigRotationSignal object to the
// community space. Tree listener emits an SSE event so the targeted
// member's frontend can call keyStates().query() locally.
func (h *MultisigHandler) HandleRotationSignal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	var req RotationSignalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}
	if req.AdminAid == "" || req.AdminSn == "" || req.TargetMemberAid == "" || req.GroupAid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "adminAid, adminSn, targetMemberAid, groupAid are required",
		})
		return
	}
	if req.Round != "round-1" && req.Round != "round-2" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "round must be 'round-1' or 'round-2'",
		})
		return
	}

	// Each rotation event is uniquely identified by (admin AID, sn). We add
	// timestamp+nano so retries within the same sn produce a fresh object.
	objectID := fmt.Sprintf("rotation-signal-%s-%s-%d", req.AdminAid, req.AdminSn, time.Now().UnixNano())

	data, _ := json.Marshal(map[string]string{
		"adminAid":        req.AdminAid,
		"adminSn":         req.AdminSn,
		"targetMemberAid": req.TargetMemberAid,
		"round":           req.Round,
		"groupAid":        req.GroupAid,
		"timestamp":       time.Now().UTC().Format(time.RFC3339Nano),
	})

	headID, err := h.writeToCommunitySpace(r, "MultisigRotationSignal", objectID, data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Multisig] rotation signal: admin=%s sn=%s target=%s round=%s",
		req.AdminAid[:12], req.AdminSn, req.TargetMemberAid[:12], req.Round)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"objectId": objectID,
		"headId":   headID,
	})
}

// RotationAckRequest is the body for POST /api/v1/multisig/rotation-ack.
type RotationAckRequest struct {
	SignalID string `json:"signalId"`
	AdminAid string `json:"adminAid"`
	AdminSn  string `json:"adminSn"`
	AckBy    string `json:"ackBy"`
}

// HandleRotationAck writes a MultisigRotationAck object to the community
// space. Admin's frontend, which is waiting on multisig:rotation-ack, can
// then proceed to send the /multisig/rot EXN knowing the member's kevers
// has been refreshed.
func (h *MultisigHandler) HandleRotationAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	var req RotationAckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}
	if req.AdminAid == "" || req.AdminSn == "" || req.AckBy == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "adminAid, adminSn, ackBy are required",
		})
		return
	}

	objectID := fmt.Sprintf("rotation-ack-%s-%s-%s-%d",
		req.AdminAid, req.AdminSn, req.AckBy, time.Now().UnixNano())

	data, _ := json.Marshal(map[string]string{
		"signalId":  req.SignalID,
		"adminAid":  req.AdminAid,
		"adminSn":   req.AdminSn,
		"ackBy":     req.AckBy,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})

	headID, err := h.writeToCommunitySpace(r, "MultisigRotationAck", objectID, data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Multisig] rotation ack: admin=%s sn=%s ackBy=%s",
		req.AdminAid[:12], req.AdminSn, req.AckBy[:12])

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"objectId": objectID,
		"headId":   headID,
	})
}

func (h *MultisigHandler) writeToCommunitySpace(r *http.Request, objType, objectID string, data []byte) (string, error) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		return "", fmt.Errorf("community space not configured")
	}
	client := h.spaceManager.GetClient()
	if client == nil {
		return "", fmt.Errorf("any-sync client not available")
	}
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		return "", fmt.Errorf("load space keys: %w", err)
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		if pub, err := keys.SigningKey.GetPublic().Marshall(); err == nil {
			ownerKey = fmt.Sprintf("%x", pub)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      objType,
		OwnerKey:  ownerKey,
		Data:      data,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	return h.spaceManager.ObjectTreeManager().AddObject(r.Context(), spaceID, payload, keys.SigningKey)
}
