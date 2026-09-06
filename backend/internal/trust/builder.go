// Package trust builds and scores a trust graph from cached KERI
// credentials, tracking membership, invitation, and steward relationships.
package trust

import (
	"context"
	"encoding/json"
	"time"

	"github.com/matou-dao/backend/internal/anystore"
)

// Builder builds a trust graph from cached credentials
type Builder struct {
	store            *anystore.LocalStore
	orgAID           string
	extraCredentials []*anystore.CachedCredential
}

// NewBuilder creates a new trust graph builder
func NewBuilder(store *anystore.LocalStore, orgAID string) *Builder {
	return &Builder{
		store:  store,
		orgAID: orgAID,
	}
}

// WithExtraCredentials adds additional credentials (e.g. from AnySync P2P)
// that are merged with anystore cache when building the trust graph.
func (b *Builder) WithExtraCredentials(creds []*anystore.CachedCredential) *Builder {
	b.extraCredentials = creds
	return b
}

// Build constructs the trust graph from all cached credentials
func (b *Builder) Build(ctx context.Context) (*Graph, error) {
	graph := NewGraph(b.orgAID)

	// Add organization as root node
	graph.AddNode(&Node{
		AID:      b.orgAID,
		Alias:    "matou",
		Role:     "Organization",
		JoinedAt: time.Time{}, // Unknown
	})

	// Get all cached credentials
	credentials, err := b.getAllCredentials(ctx)
	if err != nil {
		return nil, err
	}

	// Merge extra credentials (e.g. from AnySync P2P), deduplicating by ID
	if len(b.extraCredentials) > 0 {
		seen := make(map[string]bool, len(credentials))
		for _, c := range credentials {
			seen[c.ID] = true
		}
		for _, c := range b.extraCredentials {
			if !seen[c.ID] {
				credentials = append(credentials, c)
				seen[c.ID] = true
			}
		}
	}

	// Process each credential
	for _, cred := range credentials {
		b.processCredential(graph, cred)
	}

	// Mark bidirectional edges
	graph.MarkBidirectionalEdges()

	// Update timestamp
	graph.Updated = time.Now().UTC()

	return graph, nil
}

// getAllCredentials retrieves all credentials from the cache
func (b *Builder) getAllCredentials(ctx context.Context) ([]*anystore.CachedCredential, error) {
	collection, err := b.store.CredentialsCache(ctx)
	if err != nil {
		return nil, err
	}

	iter, err := collection.Find(nil).Iter(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = iter.Close() }()

	var credentials []*anystore.CachedCredential
	for iter.Next() {
		doc, err := iter.Doc()
		if err != nil {
			continue
		}

		var cred anystore.CachedCredential
		if err := json.Unmarshal([]byte(doc.Value().String()), &cred); err != nil {
			continue
		}
		credentials = append(credentials, &cred)
	}

	return credentials, nil
}

// processCredential adds nodes and edges from a credential
func (b *Builder) processCredential(graph *Graph, cred *anystore.CachedCredential) {
	// Extract credential data
	data := b.extractCredentialData(cred)

	// Determine edge type from schema
	edgeType := SchemaToEdgeType(cred.SchemaID)

	// Skip self-claims for edge creation (but still add nodes)
	if edgeType == EdgeTypeSelfClaim {
		// Add subject node only
		graph.AddNode(&Node{
			AID:      cred.SubjectAID,
			Alias:    data.displayName,
			Role:     data.role,
			JoinedAt: data.joinedAt,
		})
		return
	}

	// Add issuer node
	issuerRole := "Member"
	if cred.IssuerAID == b.orgAID {
		issuerRole = "Organization"
	}
	graph.AddNode(&Node{
		AID:      cred.IssuerAID,
		Role:     issuerRole,
		JoinedAt: time.Time{},
	})

	// Add subject node
	subjectRole := data.role
	if subjectRole == "" {
		subjectRole = "Member"
	}
	graph.AddNode(&Node{
		AID:      cred.SubjectAID,
		Alias:    data.displayName,
		Role:     subjectRole,
		JoinedAt: data.joinedAt,
	})

	// Create edge
	edge := &Edge{
		From:         cred.IssuerAID,
		To:           cred.SubjectAID,
		CredentialID: cred.ID,
		Type:         edgeType,
		CreatedAt:    data.joinedAt,
	}

	graph.AddEdge(edge)
}

// credentialData holds extracted data from a credential
type credentialData struct {
	role        string
	displayName string
	joinedAt    time.Time
}

// extractCredentialData extracts relevant data from credential
func (b *Builder) extractCredentialData(cred *anystore.CachedCredential) credentialData {
	data := credentialData{}

	// Try to extract data from the credential
	if cred.Data == nil {
		return data
	}

	// Convert data to map
	var dataMap map[string]interface{}
	switch v := cred.Data.(type) {
	case map[string]interface{}:
		dataMap = v
	default:
		// Try JSON unmarshal
		bytes, err := json.Marshal(cred.Data)
		if err != nil {
			return data
		}
		if err := json.Unmarshal(bytes, &dataMap); err != nil {
			return data
		}
	}

	// Extract role
	if role, ok := dataMap["role"].(string); ok {
		data.role = role
	}

	// Extract display name (from self-claims)
	if name, ok := dataMap["displayName"].(string); ok {
		data.displayName = name
	}

	// Extract joinedAt
	if joinedAt, ok := dataMap["joinedAt"].(string); ok {
		if t, err := time.Parse(time.RFC3339, joinedAt); err == nil {
			data.joinedAt = t
		}
	}

	// Extract grantedAt (for steward credentials)
	if grantedAt, ok := dataMap["grantedAt"].(string); ok {
		if t, err := time.Parse(time.RFC3339, grantedAt); err == nil {
			data.joinedAt = t
		}
	}

	return data
}

// BuildForAID builds a subgraph focused on a specific AID
func (b *Builder) BuildForAID(ctx context.Context, aid string, depth int) (*Graph, error) {
	// First build the full graph
	fullGraph, err := b.Build(ctx)
	if err != nil {
		return nil, err
	}

	// If depth is 0 or negative, return full graph
	if depth <= 0 {
		return fullGraph, nil
	}

	// Build subgraph using BFS from the target AID
	subgraph := NewGraph(b.orgAID)

	// BFS to find connected nodes within depth
	visited := make(map[string]bool)
	queue := []struct {
		aid   string
		depth int
	}{{aid, 0}}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		if visited[current.aid] {
			continue
		}
		visited[current.aid] = true

		// Add node to subgraph
		if node := fullGraph.GetNode(current.aid); node != nil {
			subgraph.AddNode(&Node{
				AID:             node.AID,
				Alias:           node.Alias,
				Role:            node.Role,
				JoinedAt:        node.JoinedAt,
				CredentialCount: node.CredentialCount,
			})
		}

		// If within depth limit, explore neighbors
		if current.depth < depth {
			// Add outgoing edges and neighbors
			for _, edge := range fullGraph.GetEdgesFrom(current.aid) {
				subgraph.AddEdge(edge)
				if !visited[edge.To] {
					queue = append(queue, struct {
						aid   string
						depth int
					}{edge.To, current.depth + 1})
				}
			}

			// Add incoming edges and neighbors
			for _, edge := range fullGraph.GetEdgesTo(current.aid) {
				subgraph.AddEdge(edge)
				if !visited[edge.From] {
					queue = append(queue, struct {
						aid   string
						depth int
					}{edge.From, current.depth + 1})
				}
			}
		}
	}

	subgraph.MarkBidirectionalEdges()
	subgraph.Updated = time.Now().UTC()

	return subgraph, nil
}
