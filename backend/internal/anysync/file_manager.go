// Package anysync provides any-sync integration for MATOU.
// file_manager.go provides high-level file management combining FileHandler,
// RemoteBlockStore, and ObjectTreeManager for P2P file storage via the filenode.
package anysync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/anyproto/any-sync/commonfile/fileproto"
	"github.com/anyproto/any-sync/commonfile/fileservice"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/any-sync/util/crypto"
	"github.com/google/uuid"
	"github.com/ipfs/go-cid"
	"storj.io/drpc"
)

// FileMetaObjectType is the ObjectPayload.Type used for file metadata in ObjectTrees.
const FileMetaObjectType = "file_meta"

// FileMeta is the metadata stored as an ObjectPayload for each uploaded file.
type FileMeta struct {
	CID         string `json:"cid"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	UploadedBy  string `json:"uploadedBy"`
	UploadedAt  int64  `json:"uploadedAt"`
}

// FileManager combines FileHandler + RemoteBlockStore + ObjectTreeManager
// for uploading/downloading files via the any-sync filenode with metadata
// persisted in ObjectTrees for P2P sync.
type FileManager struct {
	handler    *fileservice.FileHandler
	blockStore *RemoteBlockStore
	objTree    *ObjectTreeManager
	pool       pool.Pool
	nodeConf   nodeconf.Service
}

// NewFileManager creates a new FileManager.
func NewFileManager(p pool.Pool, nc nodeconf.Service, objTree *ObjectTreeManager) *FileManager {
	bs := NewRemoteBlockStore(p, nc)
	handler := fileservice.NewFileHandler(bs)
	return &FileManager{
		handler:    handler,
		blockStore: bs,
		objTree:    objTree,
		pool:       p,
		nodeConf:   nc,
	}
}

// RefreshTransport updates the pool and nodeconf references after an SDK reinit.
// The old pool is dead after Reinitialize() closes the app; this points the
// FileManager (and its RemoteBlockStore) at the new live pool.
func (m *FileManager) RefreshTransport(p pool.Pool, nc nodeconf.Service) {
	m.pool = p
	m.nodeConf = nc
	m.blockStore.RefreshTransport(p, nc)
}

// AddFile uploads a file to the filenode and records metadata in the ObjectTree.
//
// Flow:
//  1. Generate a unique fileId
//  2. Set context with spaceId and fileId for the blockstore
//  3. FileHandler.AddFile chunks the file into CID-addressed blocks and pushes
//     each to the filenode via dRPC BlockPush
//  4. BlocksBind associates all block CIDs with the fileId on the filenode
//  5. FileMeta is written as an ObjectPayload into the community space's ObjectTree
//  6. Returns the root CID string as the file reference
func (m *FileManager) AddFile(ctx context.Context, spaceID string, reader io.Reader, contentType string, size int64, signingKey crypto.PrivKey) (string, error) {
	fileId := uuid.New().String()

	// Set spaceId and fileId on the blockstore directly — the IPFS DAG builder
	// internally uses context.TODO(), so context-based values are lost.
	m.blockStore.SetContext(spaceID, fileId)

	// AddFile chunks the reader into IPFS UnixFS DAG blocks and pushes via blockstore.Add
	rootNode, err := m.handler.AddFile(ctx, reader)
	if err != nil {
		return "", fmt.Errorf("adding file to DAG: %w", err)
	}

	rootCID := rootNode.Cid()

	// Bind all block CIDs to the fileId on the filenode
	if err := m.bindBlocks(ctx, spaceID, fileId, rootCID); err != nil {
		return "", fmt.Errorf("binding blocks: %w", err)
	}

	// Write file metadata to the ObjectTree for P2P sync
	cidStr := rootCID.String()
	meta := &FileMeta{
		CID:         cidStr,
		ContentType: contentType,
		Size:        size,
		UploadedAt:  time.Now().Unix(),
	}
	if signingKey != nil {
		meta.UploadedBy = signingKey.GetPublic().Account()
	}

	metaData, err := json.Marshal(meta)
	if err != nil {
		return "", fmt.Errorf("marshaling file meta: %w", err)
	}

	payload := &ObjectPayload{
		ID:        cidStr,
		Type:      FileMetaObjectType,
		Data:      metaData,
		Timestamp: meta.UploadedAt,
		Version:   1,
	}
	if signingKey != nil {
		payload.OwnerKey = signingKey.GetPublic().Account()
	}

	if _, err := m.objTree.AddObject(ctx, spaceID, payload, signingKey); err != nil {
		// Log but don't fail — the file is already on the filenode
		fmt.Printf("[FileManager] Warning: failed to write file meta to ObjectTree: %v\n", err)
	}

	return cidStr, nil
}

// bindBlocks calls BlocksBind on the filenode to associate the root CID (and
// its DAG children) with the fileId. We collect all DAG node CIDs by walking
// the DAG service.
func (m *FileManager) bindBlocks(ctx context.Context, spaceID, fileId string, rootCID cid.Cid) error {
	filePeers := m.nodeConf.FilePeers()
	if len(filePeers) == 0 {
		return fmt.Errorf("no file peers configured")
	}

	p, err := m.pool.GetOneOf(ctx, filePeers)
	if err != nil {
		return fmt.Errorf("getting file peer: %w", err)
	}

	return p.DoDrpc(ctx, func(conn drpc.Conn) error {
		client := fileproto.NewDRPCFileClient(conn)
		_, err := client.BlocksBind(ctx, &fileproto.BlocksBindRequest{
			SpaceId: spaceID,
			FileId:  fileId,
			Cids:    [][]byte{rootCID.Bytes()},
		})
		return err
	})
}

// GetFile downloads a file from the filenode by CID and returns a reader
// along with the content type from the ObjectTree metadata.
func (m *FileManager) GetFile(ctx context.Context, spaceID string, fileRef string) (io.ReadSeekCloser, string, error) {
	c, err := cid.Decode(fileRef)
	if err != nil {
		return nil, "", fmt.Errorf("invalid CID %q: %w", fileRef, err)
	}

	m.blockStore.SetContext(spaceID, "")

	reader, err := m.handler.GetFile(ctx, c)
	if err != nil {
		return nil, "", fmt.Errorf("getting file from DAG: %w", err)
	}

	// Look up content type from ObjectTree metadata
	contentType := "application/octet-stream"
	meta, metaErr := m.GetFileMeta(ctx, spaceID, fileRef)
	if metaErr == nil && meta.ContentType != "" {
		contentType = meta.ContentType
	}

	return reader, contentType, nil
}

// GetFileMeta reads the file metadata from the ObjectTree.
func (m *FileManager) GetFileMeta(ctx context.Context, spaceID string, fileRef string) (*FileMeta, error) {
	obj, err := m.objTree.ReadLatestByID(ctx, spaceID, fileRef)
	if err != nil {
		return nil, fmt.Errorf("reading file meta: %w", err)
	}
	if obj.Type != FileMetaObjectType {
		return nil, fmt.Errorf("object %s is not a file_meta (got %s)", fileRef, obj.Type)
	}

	var meta FileMeta
	if err := json.Unmarshal(obj.Data, &meta); err != nil {
		return nil, fmt.Errorf("unmarshaling file meta: %w", err)
	}
	return &meta, nil
}
