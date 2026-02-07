#!/bin/bash
#
# Debug script for any-sync infrastructure issues
# Run from the matou-app root directory
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Determine environment
ENV="${1:-test}"
if [ "$ENV" = "test" ]; then
  BACKEND_PORT=9080
  ANYSYNC_PORTS=(2001 2002 2003 2004 2005 2006)
  ENV_FILE=".env.test"
  COMPOSE_PROJECT="matou-anysync-test"
else
  BACKEND_PORT=8080
  ANYSYNC_PORTS=(1001 1002 1003 1004 1005 1006)
  ENV_FILE=".env"
  COMPOSE_PROJECT="matou-anysync"
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  any-sync Debug Report (${ENV} mode)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# ------------------------------------------------------------------------------
# 1. Check if any-sync containers are running
# ------------------------------------------------------------------------------
echo -e "${YELLOW}1. Checking any-sync containers...${NC}"

INFRA_DIR="${MATOU_ANYSYNC_INFRA_DIR:-../matou-infrastructure/any-sync}"
if [ ! -d "$INFRA_DIR" ]; then
  echo -e "${RED}   ✗ Infrastructure directory not found: $INFRA_DIR${NC}"
  exit 1
fi

cd "$INFRA_DIR"
RUNNING_CONTAINERS=$(docker compose --env-file "$ENV_FILE" ps --format "{{.Name}} {{.Status}}" 2>/dev/null || echo "")
cd - > /dev/null

if [ -z "$RUNNING_CONTAINERS" ]; then
  echo -e "${RED}   ✗ No any-sync containers running${NC}"
  echo -e "   Run: cd $INFRA_DIR && make up-${ENV}"
  exit 1
fi

echo "$RUNNING_CONTAINERS" | while read -r line; do
  NAME=$(echo "$line" | awk '{print $1}')
  STATUS=$(echo "$line" | awk '{$1=""; print $0}' | xargs)
  if echo "$STATUS" | grep -qi "up\|running"; then
    echo -e "   ${GREEN}✓${NC} $NAME: $STATUS"
  else
    echo -e "   ${RED}✗${NC} $NAME: $STATUS"
  fi
done
echo ""

# ------------------------------------------------------------------------------
# 2. Check TCP connectivity to any-sync nodes
# ------------------------------------------------------------------------------
echo -e "${YELLOW}2. Checking TCP connectivity to any-sync nodes...${NC}"

SERVICES=("tree-1" "tree-2" "tree-3" "coordinator" "filenode" "consensus")
for i in "${!ANYSYNC_PORTS[@]}"; do
  PORT="${ANYSYNC_PORTS[$i]}"
  SERVICE="${SERVICES[$i]}"
  if timeout 2 bash -c "echo > /dev/tcp/localhost/$PORT" 2>/dev/null; then
    echo -e "   ${GREEN}✓${NC} $SERVICE (port $PORT): reachable"
  else
    echo -e "   ${RED}✗${NC} $SERVICE (port $PORT): not reachable"
  fi
done
echo ""

# ------------------------------------------------------------------------------
# 3. Check backend health
# ------------------------------------------------------------------------------
echo -e "${YELLOW}3. Checking backend health (port $BACKEND_PORT)...${NC}"

HEALTH=$(curl -s "http://localhost:$BACKEND_PORT/health" 2>/dev/null || echo '{"error":"unreachable"}')
if echo "$HEALTH" | grep -q '"status":"healthy"'; then
  echo -e "   ${GREEN}✓${NC} Backend is healthy"
  echo "$HEALTH" | jq -r '
    "   - Organization: \(.organization // "not configured")",
    "   - Credentials cached: \(.sync.credentialsCached // 0)",
    "   - Spaces created: \(.sync.spacesCreated // 0)"
  ' 2>/dev/null || echo "   $HEALTH"
else
  echo -e "   ${RED}✗${NC} Backend unhealthy or unreachable"
  echo "   Response: $HEALTH"
fi
echo ""

# ------------------------------------------------------------------------------
# 4. Check org config and spaces
# ------------------------------------------------------------------------------
echo -e "${YELLOW}4. Checking org config and spaces...${NC}"

ORG_CONFIG=$(curl -s "http://localhost:$BACKEND_PORT/api/v1/org/config" 2>/dev/null || echo '{"error":"unreachable"}')
if echo "$ORG_CONFIG" | grep -q '"organization"'; then
  ORG_NAME=$(echo "$ORG_CONFIG" | jq -r '.organization.name // "unknown"')
  echo -e "   ${GREEN}✓${NC} Organization configured: $ORG_NAME"

  # Extract space IDs
  COMMUNITY_SPACE=$(echo "$ORG_CONFIG" | jq -r '.communitySpaceId // "not set"')
  ADMIN_SPACE=$(echo "$ORG_CONFIG" | jq -r '.adminSpaceId // "not set"')
  READONLY_SPACE=$(echo "$ORG_CONFIG" | jq -r '.readOnlySpaceId // "not set"')

  echo "   - Community space: ${COMMUNITY_SPACE:0:50}..."
  echo "   - Admin space: ${ADMIN_SPACE:0:50}..."
  echo "   - ReadOnly space: ${READONLY_SPACE:0:50}..."
else
  echo -e "   ${RED}✗${NC} Organization not configured"
  echo "   Response: $ORG_CONFIG"
fi
echo ""

# ------------------------------------------------------------------------------
# 5. Check consensus node logs for errors
# ------------------------------------------------------------------------------
echo -e "${YELLOW}5. Checking consensus node logs (last 20 lines)...${NC}"

cd "$INFRA_DIR"
CONSENSUS_LOGS=$(docker compose --env-file "$ENV_FILE" logs any-sync-consensusnode --tail=20 2>/dev/null || echo "Could not fetch logs")
cd - > /dev/null

# Count errors
ERROR_COUNT=$(echo "$CONSENSUS_LOGS" | grep -ci "error\|forbidden\|denied" || echo "0")
if [ "$ERROR_COUNT" -gt 0 ]; then
  echo -e "   ${RED}✗${NC} Found $ERROR_COUNT error(s) in consensus logs:"
  echo "$CONSENSUS_LOGS" | grep -i "error\|forbidden\|denied" | tail -5 | sed 's/^/      /'
else
  echo -e "   ${GREEN}✓${NC} No errors in recent consensus logs"
fi
echo ""

# ------------------------------------------------------------------------------
# 6. Check coordinator node logs
# ------------------------------------------------------------------------------
echo -e "${YELLOW}6. Checking coordinator node logs (last 20 lines)...${NC}"

cd "$INFRA_DIR"
COORD_LOGS=$(docker compose --env-file "$ENV_FILE" logs any-sync-coordinator --tail=20 2>/dev/null || echo "Could not fetch logs")
cd - > /dev/null

ERROR_COUNT=$(echo "$COORD_LOGS" | grep -ci "error\|forbidden\|denied" || echo "0")
if [ "$ERROR_COUNT" -gt 0 ]; then
  echo -e "   ${RED}✗${NC} Found $ERROR_COUNT error(s) in coordinator logs:"
  echo "$COORD_LOGS" | grep -i "error\|forbidden\|denied" | tail -5 | sed 's/^/      /'
else
  echo -e "   ${GREEN}✓${NC} No errors in recent coordinator logs"
fi
echo ""

# ------------------------------------------------------------------------------
# 7. Compare client configs
# ------------------------------------------------------------------------------
echo -e "${YELLOW}7. Comparing client configs...${NC}"

BACKEND_CONFIG="backend/config/client-${ENV}.yml"
INFRA_CONFIG="$INFRA_DIR/etc-${ENV}/client.yml"

if [ ! -f "$BACKEND_CONFIG" ]; then
  echo -e "   ${RED}✗${NC} Backend config not found: $BACKEND_CONFIG"
elif [ ! -f "$INFRA_CONFIG" ]; then
  echo -e "   ${RED}✗${NC} Infrastructure config not found: $INFRA_CONFIG"
else
  BACKEND_NETWORK=$(grep "networkId" "$BACKEND_CONFIG" | head -1)
  INFRA_NETWORK=$(grep "networkId" "$INFRA_CONFIG" | head -1)

  if [ "$BACKEND_NETWORK" = "$INFRA_NETWORK" ]; then
    echo -e "   ${GREEN}✓${NC} Network IDs match"
    echo "   $BACKEND_NETWORK"
  else
    echo -e "   ${RED}✗${NC} Network IDs DO NOT match!"
    echo "   Backend: $BACKEND_NETWORK"
    echo "   Infra:   $INFRA_NETWORK"
    echo ""
    echo -e "   ${YELLOW}Fix: Copy the infrastructure config to backend:${NC}"
    echo "   cp $INFRA_CONFIG $BACKEND_CONFIG"
    echo "   (Then update addresses from container names to localhost)"
  fi

  # Check peer IDs match
  BACKEND_PEERS=$(grep "peerId" "$BACKEND_CONFIG" | sort)
  INFRA_PEERS=$(grep "peerId" "$INFRA_CONFIG" | sort)

  if [ "$BACKEND_PEERS" = "$INFRA_PEERS" ]; then
    echo -e "   ${GREEN}✓${NC} Peer IDs match"
  else
    echo -e "   ${RED}✗${NC} Peer IDs DO NOT match - network was regenerated!"
    echo -e "   ${YELLOW}Fix: Regenerate backend config from infrastructure${NC}"
  fi
fi
echo ""

# ------------------------------------------------------------------------------
# 8. Test space access (if org configured)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}8. Testing space access...${NC}"

SPACES_RESPONSE=$(curl -s "http://localhost:$BACKEND_PORT/api/v1/spaces" 2>/dev/null || echo '{"error":"unreachable"}')
if echo "$SPACES_RESPONSE" | grep -q '"spaces"'; then
  SPACE_COUNT=$(echo "$SPACES_RESPONSE" | jq '.spaces | length' 2>/dev/null || echo "0")
  echo -e "   ${GREEN}✓${NC} Backend can list spaces: $SPACE_COUNT space(s)"
  echo "$SPACES_RESPONSE" | jq -r '.spaces[]? | "   - \(.id[:40])... (\(.type // "unknown"))"' 2>/dev/null || true
elif echo "$SPACES_RESPONSE" | grep -q '"error"'; then
  ERROR_MSG=$(echo "$SPACES_RESPONSE" | jq -r '.error // "unknown"')
  echo -e "   ${RED}✗${NC} Cannot list spaces: $ERROR_MSG"
else
  echo -e "   ${YELLOW}?${NC} Unexpected response: $SPACES_RESPONSE"
fi
echo ""

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "If you're seeing 'forbidden' errors from consensus:"
echo ""
echo "  This typically means the peer (backend) isn't authorized on the network."
echo "  Each backend instance generates a unique peer ID from its mnemonic."
echo ""
echo "  For user backends spawned during tests, they have different peer IDs"
echo "  than the main backend and may not be able to write to existing spaces."
echo ""
echo "Troubleshooting steps:"
echo ""
echo "  1. Clean and restart the any-sync network:"
echo "     cd $INFRA_DIR && make clean-${ENV} && make up-${ENV}"
echo ""
echo "  2. Reset backend test data:"
echo "     rm -rf backend/data-${ENV}/*"
echo ""
echo "  3. Re-run org setup:"
echo "     cd frontend && npx playwright test --project=org-setup"
echo ""
echo "  4. If user backends still fail, check BackendManager configuration"
echo "     to ensure they derive keys from the same mnemonic as the user."
echo ""
