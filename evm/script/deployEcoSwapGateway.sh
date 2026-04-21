#!/usr/bin/env bash
#
# deployEcoSwapGateway.sh
#
# Deploys the EcoSwapGateway contract to multiple chains using CreateX CREATE2
# for deterministic same-address deployment. Any deployer can reproduce
# the same address on a new chain (unguarded salt).
#
# Environment variables (from .env):
#   PRIVATE_KEY       - Deployer private key
#   SALT              - Deployment salt (bytes32 hex, first 20 bytes must be zero)
#   PORTAL_ADDRESS    - Portal contract address (same on all chains)
#   CHAIN_DATA_URL    - URL or local path to chain config JSON
#   RESULTS_FILE      - Path to write deployment results CSV
#   ALCHEMY_API_KEY   - (Optional) API key for RPC URL placeholders
#   APPEND_RESULTS    - (Optional) "true" to append to existing results file

set -eo pipefail

# Resolve script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load utilities from eco-routes
source "$SCRIPT_DIR/../lib/eco-routes/scripts/utils/load_env.sh"
load_env

source "$SCRIPT_DIR/../lib/eco-routes/scripts/utils/load_chain_data.sh"

# --- Validate required environment variables ---

if [ -z "${PRIVATE_KEY:-}" ]; then
    echo "Error: PRIVATE_KEY is not set"
    exit 1
fi

if [ -z "${SALT:-}" ]; then
    echo "Error: SALT is not set"
    exit 1
fi

if [ -z "${PORTAL_ADDRESS:-}" ]; then
    echo "Error: PORTAL_ADDRESS is not set"
    exit 1
fi

if [ -z "${RESULTS_FILE:-}" ]; then
    echo "Error: RESULTS_FILE is not set"
    exit 1
fi

if [ -z "${CHAIN_DATA_URL:-}" ]; then
    echo "Error: CHAIN_DATA_URL is not set"
    exit 1
fi

# --- Load chain data ---

DEPLOY_JSON=$(load_chain_data "$CHAIN_DATA_URL")
if [ $? -ne 0 ]; then
    exit 1
fi

# --- Initialise results CSV ---

if [ -z "${APPEND_RESULTS:-}" ] || [ "$APPEND_RESULTS" != "true" ]; then
    if [ -f "$RESULTS_FILE" ]; then
        rm "$RESULTS_FILE"
    fi
    echo "ChainID,ContractAddress,ContractPath,ContractArguments" > "$RESULTS_FILE"
else
    if [ ! -f "$RESULTS_FILE" ]; then
        echo "ChainID,ContractAddress,ContractPath,ContractArguments" > "$RESULTS_FILE"
    fi
fi

# --- Log deployer info ---

PUBLIC_ADDRESS=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "Deployer : $PUBLIC_ADDRESS"
echo "Salt     : $SALT"
echo "Portal   : $PORTAL_ADDRESS"
echo ""

# --- Iterate chains ---

echo "$DEPLOY_JSON" | jq -c 'to_entries[]' | while IFS= read -r entry; do
    CHAIN_ID=$(echo "$entry" | jq -r '.key')
    value=$(echo "$entry" | jq -c '.value')

    RPC_URL=$(echo "$value" | jq -r '.url')
    GAS_MULTIPLIER=$(echo "$value" | jq -r '.gasMultiplier // ""')

    if [[ "$RPC_URL" == "null" || -z "$RPC_URL" ]]; then
        echo "Warning: Missing RPC URL for Chain ID $CHAIN_ID. Skipping..."
        continue
    fi

    # Replace environment variable placeholders (e.g. ${ALCHEMY_API_KEY})
    RPC_URL=$(eval echo "$RPC_URL")

    echo "Deploying EcoSwapGateway on Chain ID: $CHAIN_ID"

    # Build forge command
    FOUNDRY_CMD="PORTAL_ADDRESS=\"$PORTAL_ADDRESS\" SALT=\"$SALT\" DEPLOY_FILE=\"$RESULTS_FILE\" \
        forge script script/DeployEcoSwapGatewayCreateX.s.sol \
        --rpc-url \"$RPC_URL\" \
        --slow \
        --broadcast \
        --private-key \"$PRIVATE_KEY\""

    if [[ -n "$GAS_MULTIPLIER" && "$GAS_MULTIPLIER" != "null" ]]; then
        FOUNDRY_CMD+=" --gas-estimate-multiplier \"$GAS_MULTIPLIER\""
    fi

    eval $FOUNDRY_CMD

    echo "Done: Chain ID $CHAIN_ID"
    echo ""
done

echo "All deployments complete. Results: $RESULTS_FILE"
