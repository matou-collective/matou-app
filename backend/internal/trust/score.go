package trust

// ScoreWeights defines the weights for trust score calculation
type ScoreWeights struct {
	IncomingCredential    float64 // Weight per incoming credential
	UniqueIssuer          float64 // Weight per unique issuer
	BidirectionalRelation float64 // Weight per bidirectional relationship
	DepthPenalty          float64 // Penalty per level of depth from org
	OrgIssuedBonus        float64 // Bonus for credentials issued by org
}

// DefaultWeights returns the default score weights
func DefaultWeights() ScoreWeights {
	return ScoreWeights{
		IncomingCredential:    1.0,
		UniqueIssuer:          2.0,
		BidirectionalRelation: 3.0,
		DepthPenalty:          0.1,
		OrgIssuedBonus:        2.0,
	}
}

// Calculator calculates trust scores from a graph
type Calculator struct {
	weights ScoreWeights
}

// NewCalculator creates a new trust score calculator
func NewCalculator(weights ScoreWeights) *Calculator {
	return &Calculator{weights: weights}
}

// NewDefaultCalculator creates a calculator with default weights
func NewDefaultCalculator() *Calculator {
	return NewCalculator(DefaultWeights())
}

// CalculateScore calculates the trust score for a specific AID
func (c *Calculator) CalculateScore(aid string, graph *Graph) *Score {
	score := &Score{AID: aid}

	// Get node info
	if node := graph.GetNode(aid); node != nil {
		score.Alias = node.Alias
		score.Role = node.Role
	}

	// Count incoming credentials
	incomingEdges := graph.GetEdgesTo(aid)
	score.IncomingCredentials = len(incomingEdges)

	// Count outgoing credentials
	outgoingEdges := graph.GetEdgesFrom(aid)
	score.OutgoingCredentials = len(outgoingEdges)

	// Count unique issuers
	issuers := make(map[string]bool)
	for _, edge := range incomingEdges {
		issuers[edge.From] = true
	}
	score.UniqueIssuers = len(issuers)

	// Count bidirectional relationships
	for _, edge := range incomingEdges {
		if edge.Bidirectional {
			score.BidirectionalRelations++
		}
	}

	// Calculate graph depth using BFS from org
	score.GraphDepth = c.calculateDepth(aid, graph)

	// Calculate final score
	score.Score = c.computeScore(score, graph, incomingEdges)

	return score
}

// calculateDepth calculates the shortest path from org to the AID using BFS
func (c *Calculator) calculateDepth(aid string, graph *Graph) int {
	if aid == graph.OrgAID {
		return 0
	}

	// BFS from org
	visited := make(map[string]bool)
	queue := []struct {
		aid   string
		depth int
	}{{graph.OrgAID, 0}}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		if visited[current.aid] {
			continue
		}
		visited[current.aid] = true

		// Check if we found the target
		if current.aid == aid {
			return current.depth
		}

		// Add neighbors (following outgoing edges from org toward members)
		for _, edge := range graph.GetEdgesFrom(current.aid) {
			if !visited[edge.To] {
				queue = append(queue, struct {
					aid   string
					depth int
				}{edge.To, current.depth + 1})
			}
		}
	}

	// Not reachable from org - return -1 or max depth
	return -1
}

// computeScore computes the final trust score
func (c *Calculator) computeScore(s *Score, graph *Graph, incomingEdges []*Edge) float64 {
	score := 0.0

	// Base score from incoming credentials
	score += float64(s.IncomingCredentials) * c.weights.IncomingCredential

	// Bonus for unique issuers (diversity of trust sources)
	score += float64(s.UniqueIssuers) * c.weights.UniqueIssuer

	// Bonus for bidirectional relationships (mutual trust)
	score += float64(s.BidirectionalRelations) * c.weights.BidirectionalRelation

	// Bonus for org-issued credentials
	for _, edge := range incomingEdges {
		if edge.From == graph.OrgAID {
			score += c.weights.OrgIssuedBonus
		}
	}

	// Penalty for depth (closer to org = higher trust)
	if s.GraphDepth > 0 {
		score -= float64(s.GraphDepth) * c.weights.DepthPenalty
	}

	// Ensure score is not negative
	if score < 0 {
		score = 0
	}

	return score
}

// CalculateAllScores calculates trust scores for all nodes in the graph
func (c *Calculator) CalculateAllScores(graph *Graph) map[string]*Score {
	scores := make(map[string]*Score)

	for aid := range graph.Nodes {
		scores[aid] = c.CalculateScore(aid, graph)
	}

	return scores
}

// GetTopScores returns the top N nodes by trust score
func (c *Calculator) GetTopScores(graph *Graph, limit int) []*Score {
	allScores := c.CalculateAllScores(graph)

	// Convert to slice
	scores := make([]*Score, 0, len(allScores))
	for _, s := range allScores {
		scores = append(scores, s)
	}

	// Sort by score descending (simple bubble sort for small N)
	for i := 0; i < len(scores)-1; i++ {
		for j := i + 1; j < len(scores); j++ {
			if scores[j].Score > scores[i].Score {
				scores[i], scores[j] = scores[j], scores[i]
			}
		}
	}

	// Return top N
	if limit > len(scores) {
		limit = len(scores)
	}
	return scores[:limit]
}

// ScoreSummary provides a summary of trust scores in the graph
type ScoreSummary struct {
	TotalNodes         int     `json:"totalNodes"`
	TotalEdges         int     `json:"totalEdges"`
	AverageScore       float64 `json:"averageScore"`
	MaxScore           float64 `json:"maxScore"`
	MinScore           float64 `json:"minScore"`
	MedianDepth        int     `json:"medianDepth"`
	BidirectionalCount int     `json:"bidirectionalCount"`
}

// CalculateSummary calculates a summary of trust scores
func (c *Calculator) CalculateSummary(graph *Graph) *ScoreSummary {
	summary := &ScoreSummary{
		TotalNodes: graph.NodeCount(),
		TotalEdges: graph.EdgeCount(),
	}

	if summary.TotalNodes == 0 {
		return summary
	}

	allScores := c.CalculateAllScores(graph)

	var totalScore float64
	summary.MinScore = -1
	depths := make([]int, 0)

	for _, s := range allScores {
		totalScore += s.Score

		if summary.MinScore < 0 || s.Score < summary.MinScore {
			summary.MinScore = s.Score
		}
		if s.Score > summary.MaxScore {
			summary.MaxScore = s.Score
		}

		if s.GraphDepth >= 0 {
			depths = append(depths, s.GraphDepth)
		}
	}

	summary.AverageScore = totalScore / float64(len(allScores))

	// Calculate median depth
	if len(depths) > 0 {
		// Simple sort
		for i := 0; i < len(depths)-1; i++ {
			for j := i + 1; j < len(depths); j++ {
				if depths[j] < depths[i] {
					depths[i], depths[j] = depths[j], depths[i]
				}
			}
		}
		summary.MedianDepth = depths[len(depths)/2]
	}

	// Count bidirectional edges
	for _, edge := range graph.Edges {
		if edge.Bidirectional {
			summary.BidirectionalCount++
		}
	}
	// Each bidirectional relationship is counted twice, so divide by 2
	summary.BidirectionalCount /= 2

	return summary
}
