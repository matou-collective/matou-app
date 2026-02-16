// Package anysync provides any-sync integration for MATOU.
// file_blockstore.go implements a remote blockstore that proxies to the
// any-sync filenode via dRPC for P2P file storage.
package anysync

import (
	"context"
	"fmt"
	"sync"

	"github.com/anyproto/any-sync/commonfile/fileblockstore"
	"github.com/anyproto/any-sync/commonfile/fileproto"
	"github.com/anyproto/any-sync/net/peer"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	blocks "github.com/ipfs/go-block-format"
	"github.com/ipfs/go-cid"
	"storj.io/drpc"
)

// Compile-time check that RemoteBlockStore implements BlockStoreLocal.
var _ fileblockstore.BlockStoreLocal = (*RemoteBlockStore)(nil)

// RemoteBlockStore implements fileblockstore.BlockStoreLocal by proxying
// block operations to the any-sync filenode via dRPC. The spaceId and fileId
// are stored as fields (set by FileManager before calling FileHandler) because
// the IPFS DAG builder internally uses context.TODO(), dropping any context
// values set via fileblockstore.CtxWithSpaceId/CtxWithFileId.
type RemoteBlockStore struct {
	pool     pool.Pool
	nodeConf nodeconf.Service

	mu      sync.RWMutex
	spaceId string
	fileId  string
}

// NewRemoteBlockStore creates a new RemoteBlockStore.
func NewRemoteBlockStore(p pool.Pool, nc nodeconf.Service) *RemoteBlockStore {
	return &RemoteBlockStore{
		pool:     p,
		nodeConf: nc,
	}
}

// RefreshTransport replaces the pool and nodeconf references.
// This must be called after SDKClient.Reinitialize() because the old pool
// is closed when the app shuts down and the new app creates a fresh pool.
func (s *RemoteBlockStore) RefreshTransport(p pool.Pool, nc nodeconf.Service) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pool = p
	s.nodeConf = nc
}

// SetContext sets the spaceId and fileId for subsequent blockstore operations.
// Must be called before FileHandler.AddFile/GetFile since the IPFS DAG builder
// does not propagate the caller's context.
func (s *RemoteBlockStore) SetContext(spaceId, fileId string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spaceId = spaceId
	s.fileId = fileId
}

// getSpaceId returns the current spaceId, preferring the context value if set,
// falling back to the stored field.
func (s *RemoteBlockStore) getSpaceId(ctx context.Context) string {
	if id := fileblockstore.CtxGetSpaceId(ctx); id != "" {
		return id
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.spaceId
}

// getFileId returns the current fileId, preferring the context value if set,
// falling back to the stored field.
func (s *RemoteBlockStore) getFileId(ctx context.Context) string {
	if id := fileblockstore.CtxGetFileId(ctx); id != "" {
		return id
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.fileId
}

// getFilePeer returns a connected peer from the configured file nodes.
func (s *RemoteBlockStore) getFilePeer(ctx context.Context) (peer.Peer, error) {
	s.mu.RLock()
	p := s.pool
	nc := s.nodeConf
	s.mu.RUnlock()

	filePeers := nc.FilePeers()
	if len(filePeers) == 0 {
		return nil, fmt.Errorf("no file peers configured")
	}
	return p.GetOneOf(ctx, filePeers)
}

// Get fetches a single block from the filenode by CID.
func (s *RemoteBlockStore) Get(ctx context.Context, k cid.Cid) (blocks.Block, error) {
	spaceId := s.getSpaceId(ctx)

	p, err := s.getFilePeer(ctx)
	if err != nil {
		return nil, fmt.Errorf("getting file peer: %w", err)
	}

	var result blocks.Block
	err = p.DoDrpc(ctx, func(conn drpc.Conn) error {
		client := fileproto.NewDRPCFileClient(conn)
		resp, err := client.BlockGet(ctx, &fileproto.BlockGetRequest{
			SpaceId: spaceId,
			Cid:     k.Bytes(),
			Wait:    true,
		})
		if err != nil {
			return err
		}
		result, err = blocks.NewBlockWithCid(resp.Data, k)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("block get %s: %w", k.String(), err)
	}
	return result, nil
}

// GetMany fetches multiple blocks from the filenode. Returns a channel that
// yields blocks as they are retrieved.
func (s *RemoteBlockStore) GetMany(ctx context.Context, ks []cid.Cid) <-chan blocks.Block {
	ch := make(chan blocks.Block, len(ks))
	go func() {
		defer close(ch)
		for _, k := range ks {
			b, err := s.Get(ctx, k)
			if err != nil {
				continue
			}
			select {
			case ch <- b:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch
}

// Add pushes blocks to the filenode via dRPC BlockPush. The spaceId and fileId
// are read from the stored fields (set by FileManager.SetContext), with context
// values as fallback.
func (s *RemoteBlockStore) Add(ctx context.Context, bs []blocks.Block) error {
	spaceId := s.getSpaceId(ctx)
	fileId := s.getFileId(ctx)

	p, err := s.getFilePeer(ctx)
	if err != nil {
		return fmt.Errorf("getting file peer: %w", err)
	}

	return p.DoDrpc(ctx, func(conn drpc.Conn) error {
		client := fileproto.NewDRPCFileClient(conn)
		for _, b := range bs {
			_, err := client.BlockPush(ctx, &fileproto.BlockPushRequest{
				SpaceId: spaceId,
				FileId:  fileId,
				Cid:     b.Cid().Bytes(),
				Data:    b.RawData(),
			})
			if err != nil {
				return fmt.Errorf("pushing block %s: %w", b.Cid().String(), err)
			}
		}
		return nil
	})
}

// Delete is a no-op — the filenode manages block deletion via FilesDelete.
func (s *RemoteBlockStore) Delete(ctx context.Context, c cid.Cid) error {
	return nil
}

// ExistsCids checks which CIDs exist on the filenode via BlocksCheck.
func (s *RemoteBlockStore) ExistsCids(ctx context.Context, ks []cid.Cid) ([]cid.Cid, error) {
	spaceId := s.getSpaceId(ctx)

	p, err := s.getFilePeer(ctx)
	if err != nil {
		return nil, fmt.Errorf("getting file peer: %w", err)
	}

	cidBytes := make([][]byte, len(ks))
	for i, k := range ks {
		cidBytes[i] = k.Bytes()
	}

	var exists []cid.Cid
	err = p.DoDrpc(ctx, func(conn drpc.Conn) error {
		client := fileproto.NewDRPCFileClient(conn)
		resp, err := client.BlocksCheck(ctx, &fileproto.BlocksCheckRequest{
			SpaceId: spaceId,
			Cids:    cidBytes,
		})
		if err != nil {
			return err
		}
		for _, ba := range resp.BlocksAvailability {
			if ba.Status != fileproto.AvailabilityStatus_NotExists {
				c, err := cid.Cast(ba.Cid)
				if err != nil {
					continue
				}
				exists = append(exists, c)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("blocks check: %w", err)
	}
	return exists, nil
}

// NotExistsBlocks returns the subset of blocks whose CIDs do not exist on the filenode.
func (s *RemoteBlockStore) NotExistsBlocks(ctx context.Context, bs []blocks.Block) ([]blocks.Block, error) {
	if len(bs) == 0 {
		return nil, nil
	}

	ks := make([]cid.Cid, len(bs))
	for i, b := range bs {
		ks[i] = b.Cid()
	}

	existsCids, err := s.ExistsCids(ctx, ks)
	if err != nil {
		return nil, err
	}

	existsSet := make(map[string]struct{}, len(existsCids))
	for _, c := range existsCids {
		existsSet[c.String()] = struct{}{}
	}

	var notExists []blocks.Block
	for _, b := range bs {
		if _, ok := existsSet[b.Cid().String()]; !ok {
			notExists = append(notExists, b)
		}
	}
	return notExists, nil
}
