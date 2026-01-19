// Package anystore provides a local document database wrapper using any-store.
// This file implements the SpaceStore adapter for the anysync package.
package anystore

import (
	"context"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
)

// SpaceStoreAdapter adapts LocalStore to implement anysync.SpaceStore interface
type SpaceStoreAdapter struct {
	store *LocalStore
}

// NewSpaceStoreAdapter creates a new adapter for the LocalStore
func NewSpaceStoreAdapter(store *LocalStore) *SpaceStoreAdapter {
	return &SpaceStoreAdapter{store: store}
}

// GetUserSpace retrieves a user's private space
func (a *SpaceStoreAdapter) GetUserSpace(ctx context.Context, userAID string) (*anysync.Space, error) {
	record, err := a.store.GetUserSpaceRecord(ctx, userAID)
	if err != nil {
		return nil, err
	}

	return &anysync.Space{
		SpaceID:   record.ID,
		OwnerAID:  record.UserAID,
		SpaceType: record.SpaceType,
		SpaceName: record.SpaceName,
		CreatedAt: record.CreatedAt,
		LastSync:  record.LastSync,
	}, nil
}

// SaveSpace saves a space record to the local store
func (a *SpaceStoreAdapter) SaveSpace(ctx context.Context, space *anysync.Space) error {
	record := &SpaceRecord{
		ID:        space.SpaceID,
		UserAID:   space.OwnerAID,
		SpaceType: space.SpaceType,
		SpaceName: space.SpaceName,
		CreatedAt: space.CreatedAt,
		LastSync:  space.LastSync,
	}

	// Set defaults if not provided
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now().UTC()
	}
	if record.LastSync.IsZero() {
		record.LastSync = time.Now().UTC()
	}

	return a.store.SaveSpaceRecord(ctx, record)
}

// ListAllSpaces retrieves all space records
func (a *SpaceStoreAdapter) ListAllSpaces(ctx context.Context) ([]*anysync.Space, error) {
	records, err := a.store.ListAllSpaceRecords(ctx)
	if err != nil {
		return nil, err
	}

	spaces := make([]*anysync.Space, len(records))
	for i, record := range records {
		spaces[i] = &anysync.Space{
			SpaceID:   record.ID,
			OwnerAID:  record.UserAID,
			SpaceType: record.SpaceType,
			SpaceName: record.SpaceName,
			CreatedAt: record.CreatedAt,
			LastSync:  record.LastSync,
		}
	}

	return spaces, nil
}

// Ensure SpaceStoreAdapter implements anysync.SpaceStore
var _ anysync.SpaceStore = (*SpaceStoreAdapter)(nil)
