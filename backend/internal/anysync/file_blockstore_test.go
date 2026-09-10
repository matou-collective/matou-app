package anysync

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonfile/fileblockstore"
	"github.com/anyproto/any-sync/net/peer"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/go-chash"
	"github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
	"storj.io/drpc"
)

// --- mock pool & peer for testing ---

type mockPool struct {
	peer peer.Peer
	err  error
}

func (p *mockPool) Get(_ context.Context, _ string) (peer.Peer, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.peer, nil
}

func (p *mockPool) GetOneOf(_ context.Context, _ []string) (peer.Peer, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.peer, nil
}

func (p *mockPool) AddPeer(_ context.Context, _ peer.Peer) error { return nil }
func (p *mockPool) Pick(_ context.Context, _ string) (peer.Peer, error) {
	return nil, fmt.Errorf("not implemented")
}
func (p *mockPool) Flush(_ context.Context) error { return nil }

// Compile-time check
var _ pool.Pool = (*mockPool)(nil)

type mockPeer struct {
	doFn func(ctx context.Context, do func(conn drpc.Conn) error) error
}

func (p *mockPeer) Id() string                                           { return "mock-file-peer" } //nolint:revive // method name fixed by peer.Peer interface
func (p *mockPeer) Context() context.Context                             { return context.Background() }
func (p *mockPeer) AcquireDrpcConn(_ context.Context) (drpc.Conn, error) { return nil, nil }
func (p *mockPeer) ReleaseDrpcConn(_ context.Context, _ drpc.Conn)       {}
func (p *mockPeer) IsClosed() bool                                       { return false }
func (p *mockPeer) CloseChan() <-chan struct{}                           { return make(chan struct{}) }
func (p *mockPeer) SetTTL(_ time.Duration)                               {}
func (p *mockPeer) TryClose(_ time.Duration) (bool, error)               { return false, nil }
func (p *mockPeer) Close() error                                         { return nil }

func (p *mockPeer) DoDrpc(ctx context.Context, do func(conn drpc.Conn) error) error {
	if p.doFn != nil {
		return p.doFn(ctx, do)
	}
	return fmt.Errorf("no doFn configured")
}

type mockNodeConf struct {
	filePeers []string
}

func (n *mockNodeConf) Init(_ *app.App) error                   { return nil }
func (n *mockNodeConf) Name() string                            { return nodeconf.CName }
func (n *mockNodeConf) Run(_ context.Context) error             { return nil }
func (n *mockNodeConf) Close(_ context.Context) error           { return nil }
func (n *mockNodeConf) Id() string                              { return "mock-conf" } //nolint:revive // method name fixed by nodeconf.NodeConf interface
func (n *mockNodeConf) Configuration() nodeconf.Configuration   { return nodeconf.Configuration{} }
func (n *mockNodeConf) NodeIds(_ string) []string               { return nil } //nolint:revive // method name fixed by nodeconf.NodeConf interface
func (n *mockNodeConf) IsResponsible(_ string) bool             { return false }
func (n *mockNodeConf) FilePeers() []string                     { return n.filePeers }
func (n *mockNodeConf) ConsensusPeers() []string                { return nil }
func (n *mockNodeConf) CoordinatorPeers() []string              { return nil }
func (n *mockNodeConf) NamingNodePeers() []string               { return nil }
func (n *mockNodeConf) PaymentProcessingNodePeers() []string    { return nil }
func (n *mockNodeConf) PeerAddresses(_ string) ([]string, bool) { return nil, false }
func (n *mockNodeConf) CHash() chash.CHash                      { return nil }
func (n *mockNodeConf) Partition(_ string) int                  { return 0 }
func (n *mockNodeConf) NodeTypes(_ string) []nodeconf.NodeType  { return nil }
func (n *mockNodeConf) NetworkCompatibilityStatus() nodeconf.NetworkCompatibilityStatus {
	return nodeconf.NetworkCompatibilityStatusOk
}

// --- helper ---

func makeCID(data []byte) cid.Cid {
	hash, _ := mh.Sum(data, mh.SHA2_256, -1)
	return cid.NewCidV1(cid.Raw, hash)
}

// --- tests ---

func TestRemoteBlockStore_ImplementsInterface(_ *testing.T) {
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
	mp := &mockPeer{doFn: func(_ context.Context, _ func(conn drpc.Conn) error) error {
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

	spaceID := fileblockstore.CtxGetSpaceId(ctx)
	fileID := fileblockstore.CtxGetFileId(ctx)

	if spaceID != "space-123" {
		t.Errorf("expected space-123, got %s", spaceID)
	}
	if fileID != "file-456" {
		t.Errorf("expected file-456, got %s", fileID)
	}
}
