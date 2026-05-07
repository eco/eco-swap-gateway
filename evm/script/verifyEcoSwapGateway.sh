#!/usr/bin/env bash
#
# verifyEcoSwapGateway.sh
#
# Verifies the deployed EcoSwapGateway contract on block explorers for all chains.
# Reads deployment data from the results CSV and uses chain-specific API keys.
#
# Environment variables (from .env):
#   RESULTS_FILE          - Path to deployment results CSV
#   VERIFICATION_KEYS_FILE - Path to JSON file mapping chainId → explorer API key
#   VERIFICATION_KEYS     - (Alternative) JSON string with the same mapping
#   CHAIN_DATA_URL        - Chain config JSON (for RPC URLs)
#   ALCHEMY_API_KEY       - (Optional) For RPC URL placeholders

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/../lib/eco-routes/scripts/utils/load_env.sh"
load_env

source "$SCRIPT_DIR/../lib/eco-routes/scripts/utils/load_chain_data.sh"

# --- Validate ---

if [ ! -f "${RESULTS_FILE:-}" ]; then
    echo "Error: RESULTS_FILE not found at '${RESULTS_FILE:-}'"
    echo "Run deployEcoSwapGateway.sh first."
    exit 1
fi

# Load verification keys from file or env var
VERIFICATION_KEYS_JSON=""
if [ -n "${VERIFICATION_KEYS:-}" ]; then
    VERIFICATION_KEYS_JSON="$VERIFICATION_KEYS"
elif [ -f "${VERIFICATION_KEYS_FILE:-}" ]; then
    VERIFICATION_KEYS_JSON=$(cat "$VERIFICATION_KEYS_FILE")
else
    echo "Error: Set VERIFICATION_KEYS_FILE (path to JSON) or VERIFICATION_KEYS (inline JSON)."
    exit 1
fi

if ! echo "$VERIFICATION_KEYS_JSON" | jq empty 2>/dev/null; then
    echo "Error: Verification keys are not valid JSON"
    exit 1
fi

# --- Load chain data for RPC URLs ---

CHAIN_JSON=""
if [ -n "${CHAIN_DATA_URL:-}" ]; then
    CHAIN_JSON=$(load_chain_data "$CHAIN_DATA_URL") || CHAIN_JSON=""
fi

# --- Strip CSV header if present ---

FIRST_LINE=$(head -n 1 "$RESULTS_FILE")
if [[ "$FIRST_LINE" == *"ChainID"* ]]; then
    TEMP_FILE=$(mktemp)
    tail -n +2 "$RESULTS_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$RESULTS_FILE"
fi

TOTAL=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
COUNT=0
PASS=0
FAIL=0

echo "Verifying $TOTAL contract(s) from $RESULTS_FILE"
echo ""

# --- Verify each entry ---

while IFS=, read -r CHAIN_ID CONTRACT_ADDRESS CONTRACT_PATH CONSTRUCTOR_ARGS; do
    COUNT=$((COUNT + 1))
    echo "[$COUNT/$TOTAL] Chain $CHAIN_ID — $CONTRACT_ADDRESS"

    # Look up API key
    API_KEY=$(echo "$VERIFICATION_KEYS_JSON" | jq -r --arg c "$CHAIN_ID" '.[$c] // empty')
    if [ -z "$API_KEY" ]; then
        echo "  Skipped: no API key for chain $CHAIN_ID"
        FAIL=$((FAIL + 1))
        echo ""
        continue
    fi

    # Look up RPC URL
    RPC_URL=""
    if [ -n "$CHAIN_JSON" ]; then
        RPC_URL=$(echo "$CHAIN_JSON" | jq -r --arg c "$CHAIN_ID" '.[$c].url // empty')
        if [ -n "$RPC_URL" ] && [ "$RPC_URL" != "null" ]; then
            RPC_URL=$(eval echo "$RPC_URL")
        else
            RPC_URL=""
        fi
    fi

    # Build command
    CMD="forge verify-contract --chain $CHAIN_ID"
    CMD+=" --etherscan-api-key \"$API_KEY\""
    [ -n "$RPC_URL" ] && CMD+=" --rpc-url \"$RPC_URL\""
    CMD+=" --watch"
    if [ -n "$CONSTRUCTOR_ARGS" ] && [ "$CONSTRUCTOR_ARGS" != "0x" ]; then
        CMD+=" --constructor-args \"$CONSTRUCTOR_ARGS\""
    fi
    CMD+=" \"$CONTRACT_ADDRESS\" \"$CONTRACT_PATH\""

    # Run with one retry
    if eval "$CMD"; then
        echo "  Verified"
        PASS=$((PASS + 1))
    else
        echo "  Retrying in 5s..."
        sleep 5
        if eval "$CMD"; then
            echo "  Verified on retry"
            PASS=$((PASS + 1))
        else
            echo "  Failed"
            FAIL=$((FAIL + 1))
        fi
    fi
    echo ""
done < "$RESULTS_FILE"

echo "Done: $PASS verified, $FAIL failed (out of $TOTAL)"
