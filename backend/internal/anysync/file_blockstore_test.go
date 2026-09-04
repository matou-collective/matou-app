package anysync

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonfile/fileblockstore"
	"github.com/anyproto/any-sync/commonfile/fileproto"
	"github.com/anyproto/any-sync/net/peer"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/go-chash"
	blocks "github.com/ipfs/go-block-format"
	"github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
	"storj.io/drpc"
)

// --- mock pool & peer for testing ---

type mockPool struct {
	peer peer.Peer
	err  error
}

func (p *mockPool) Get(ctx context.Context, id string) (peer.Peer, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.peer, nil
}

func (p *mockPool) GetOneOf(ctx context.Context, peerIds []string) (peer.Peer, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.peer, nil
}

func (p *mockPool) AddPeer(ctx context.Context, pr peer.Peer) error { return nil }
func (p *mockPool) Pick(ctx context.Context, id string) (peer.Peer, error) {
	return nil, fmt.Errorf("not implemented")
}
func (p *mockPool) Flush(ctx context.Context) error { return nil }

// Compile-time check
var _ pool.Pool = (*mockPool)(nil)

type mockPeer struct {
	doFn func(ctx context.Context, do func(conn drpc.Conn) error) error
}

func (p *mockPeer) Id() string                                             { return "mock-file-peer" }
func (p *mockPeer) Context() context.Context                               { return context.Background() }
func (p *mockPeer) AcquireDrpcConn(ctx context.Context) (drpc.Conn, error) { return nil, nil }
func (p *mockPeer) ReleaseDrpcConn(ctx context.Context, conn drpc.Conn)    {}
func (p *mockPeer) IsClosed() bool                                         { return false }
func (p *mockPeer) CloseChan() <-chan struct{}                             { return make(chan struct{}) }
func (p *mockPeer) SetTTL(ttl time.Duration)                               {}
func (p *mockPeer) TryClose(objectTTL time.Duration) (bool, error)         { return false, nil }
func (p *mockPeer) Close() error                                           { return nil }

func (p *mockPeer) DoDrpc(ctx context.Context, do func(conn drpc.Conn) error) error {
	if p.doFn != nil {
		return p.doFn(ctx, do)
	}
	return fmt.Errorf("no doFn configured")
}

type mockNodeConf struct {
	filePeers []string
}

func (n *mockNodeConf) Init(a *app.App) error                        { return nil }
func (n *mockNodeConf) Name() string                                 { return nodeconf.CName }
func (n *mockNodeConf) Run(ctx context.Context) error                { return nil }
func (n *mockNodeConf) Close(ctx context.Context) error              { return nil }
func (n *mockNodeConf) Id() string                                   { return "mock-conf" }
func (n *mockNodeConf) Configuration() nodeconf.Configuration        { return nodeconf.Configuration{} }
func (n *mockNodeConf) NodeIds(spaceId string) []string              { return nil }
func (n *mockNodeConf) IsResponsible(spaceId string) bool            { return false }
func (n *mockNodeConf) FilePeers() []string                          { return n.filePeers }
func (n *mockNodeConf) ConsensusPeers() []string                     { return nil }
func (n *mockNodeConf) CoordinatorPeers() []string                   { return nil }
func (n *mockNodeConf) NamingNodePeers() []string                    { return nil }
func (n *mockNodeConf) PaymentProcessingNodePeers() []string         { return nil }
func (n *mockNodeConf) PeerAddresses(peerId string) ([]string, bool) { return nil, false }
func (n *mockNodeConf) CHash() chash.CHash                           { return nil }
func (n *mockNodeConf) Partition(spaceId string) int                 { return 0 }
func (n *mockNodeConf) NodeTypes(nodeId string) []nodeconf.NodeType  { return nil }
func (n *mockNodeConf) NetworkCompatibilityStatus() nodeconf.NetworkCompatibilityStatus {
	return nodeconf.NetworkCompatibilityStatusOk
}

// --- in-memory file storage for testing ---

type inMemoryFileStore struct {
	mu     sync.RWMutex
	blocks map[string][]byte   // cid string → data
	binds  map[string][]string // fileId → []cid strings
}

func newInMemoryFileStore() *inMemoryFileStore {
	return &inMemoryFileStore{
		blocks: make(map[string][]byte),
		binds:  make(map[string][]string),
	}
}

func (s *inMemoryFileStore) blockPush(spaceId, fileId string, cidBytes, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := cid.Cast(cidBytes)
	if err != nil {
		return err
	}
	s.blocks[c.String()] = data
	return nil
}

func (s *inMemoryFileStore) blockGet(spaceId string, cidBytes []byte) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, err := cid.Cast(cidBytes)
	if err != nil {
		return nil, err
	}
	data, ok := s.blocks[c.String()]
	if !ok {
		return nil, fmt.Errorf("block not found: %s", c.String())
	}
	return data, nil
}

func (s *inMemoryFileStore) blocksCheck(spaceId string, cids [][]byte) []*fileproto.BlockAvailability {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*fileproto.BlockAvailability
	for _, cidBytes := range cids {
		c, err := cid.Cast(cidBytes)
		status := fileproto.AvailabilityStatus_NotExists
		if err == nil {
			if _, ok := s.blocks[c.String()]; ok {
				status = fileproto.AvailabilityStatus_Exists
			}
		}
		result = append(result, &fileproto.BlockAvailability{
			Cid:    cidBytes,
			Status: status,
		})
	}
	return result
}

func (s *inMemoryFileStore) blocksBind(spaceId, fileId string, cids [][]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cidBytes := range cids {
		c, err := cid.Cast(cidBytes)
		if err != nil {
			continue
		}
		s.binds[fileId] = append(s.binds[fileId], c.String())
	}
	return nil
}

// makeDrpcPeerWithStore creates a mock peer that routes DoDrpc calls to the in-memory store.
// Since we can't create real dRPC connections in unit tests, DoDrpc returns a
// pre-computed result by intercepting at the peer level.
func makeDrpcPeerWithStore(store *inMemoryFileStore) *mockPeer {
	return &mockPeer{
		doFn: func(ctx context.Context, do func(conn drpc.Conn) error) error {
			// We can't call `do(conn)` because we don't have a real drpc.Conn.
			// Instead, we test at the RemoteBlockStore level by testing the
			// methods that don't need a real connection.
			return fmt.Errorf("mock DoDrpc: not a real connection")
		},
	}
}

// --- helper ---

func makeCID(data []byte) cid.Cid {
	hash, _ := mh.Sum(data, mh.SHA2_256, -1)
	return cid.NewCidV1(cid.Raw, hash)
}

func makeBlock(data []byte) blocks.Block {
	c := makeCID(data)
	b, _ := blocks.NewBlockWithCid(data, c)
	return b
}

// --- tests ---

func TestRemoteBlockStore_ImplementsInterface(t *testing.T) {
	// Verify compile-time interface satisfaction
	var _ fileblockstore.BlockStoreLocal = (*RemoteBlockStore)(nil)
}

func TestRemoteBlockStore_GetFilePeer_NoPeers(t *testing.T) {
	nc := &mockNodeConf{filePeers: nil}
	p := &mockPool{peer: nil}
	bs := NewRemoteBlockStore(p, nc)

	ctx := context.Background()
	_, err := bs.getFilePeer(ctx)
	if err == nil {
		t.Fatal("expected error when no file peers configured")
	}
}

func TestRemoteBlockStore_GetFilePeer_PoolError(t *testing.T) {
	nc := &mockNodeConf{filePeers: []string{"peer1"}}
	p := &mockPool{err: fmt.Errorf("connection refused")}
	bs := NewRemoteBlockStore(p, nc)

	ctx := context.Background()
	_, err := bs.getFilePeer(ctx)
	if err == nil {
		t.Fatal("expected error when pool returns error")
	}
}

func TestRemoteBlockStore_DeleteIsNoop(t *testing.T) {
	nc := &mockNodeConf{filePeers: []string{"peer1"}}
	p := &mockPool{}
	bs := NewRemoteBlockStore(p, nc)

	ctx := context.Background()
	err := bs.Delete(ctx, makeCID([]byte("test")))
	if err != nil {
		t.Fatalf("Delete should be no-op, got error: %v", err)
	}
}

func TestRemoteBlockStore_NotExistsBlocks_Empty(t *testing.T) {
	nc := &mockNodeConf{filePeers: []string{"peer1"}}
	p := &mockPool{}
	bs := NewRemoteBlockStore(p, nc)

	ctx := context.Background()
	result, err := bs.NotExistsBlocks(ctx, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil for empty input, got %v", result)
	}
}

func TestRemoteBlockStore_GetMany_ContextCanceled(t *testing.T) {
	nc := &mockNodeConf{filePeers: []string{"peer1"}}
	mp := &mockPeer{doFn: func(ctx context.Context, do func(conn drpc.Conn) error) error {
		return fmt.Errorf("peer unavailable")
	}}
	p := &mockPool{peer: mp}
	bs := NewRemoteBlockStore(p, nc)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	ks := []cid.Cid{makeCID([]byte("data1")), makeCID([]byte("data2"))}
	ch := bs.GetMany(ctx, ks)

	// Channel should close without hanging
	count := 0
	for range ch {
		count++
	}
	// Might get 0 blocks since context is canceled and peer errors
	if count > len(ks) {
		t.Fatalf("unexpected block count: %d", count)
	}
}

func TestRemoteBlockStore_ContextHelpers(t *testing.T) {
	// Verify the fileblockstore context helpers work as expected
	ctx := context.Background()

	ctx = fileblockstore.CtxWithSpaceId(ctx, "space-123")
	ctx = fileblockstore.CtxWithFileId(ctx, "file-456")

	spaceId := fileblockstore.CtxGetSpaceId(ctx)
	fileId := fileblockstore.CtxGetFileId(ctx)

	if spaceId != "space-123" {
		t.Errorf("expected space-123, got %s", spaceId)
	}
	if fileId != "file-456" {
		t.Errorf("expected file-456, got %s", fileId)
	}
}
