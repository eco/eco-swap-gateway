// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {EcoSwapGateway} from "../contracts/EcoSwapGateway.sol";

/// @notice Minimal CreateX interface – only the functions this script needs.
interface ICreateX {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address);
    function computeCreate2Address(bytes32 salt, bytes32 initCodeHash) external view returns (address);
}

/// @title DeployEcoSwapGatewayCreateX
/// @notice Deploys EcoSwapGateway via CreateX CREATE2 for deterministic same-address
///         deployment across many chains.
/// @dev    Any deployer can reproduce the same address on a new chain.
///         CreateX._guard hashes the salt via keccak256(abi.encode(salt)),
///         so we apply the same transform when predicting the address.
contract DeployEcoSwapGatewayCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        // --- Read environment ---
        bytes32 salt = vm.envBytes32("SALT");
        address portalAddress = vm.envAddress("PORTAL_ADDRESS");
        string memory deployFilePath = vm.envString("DEPLOY_FILE");

        // --- Validate CreateX is present on this chain ---
        require(address(CREATEX).code.length > 0, "CreateX not deployed on this chain");

        // --- Build init code ---
        bytes memory initCode = abi.encodePacked(
            type(EcoSwapGateway).creationCode,
            abi.encode(portalAddress)
        );
        bytes32 initCodeHash = keccak256(initCode);

        // --- Predict deployment address ---
        // CreateX._guard hashes the salt before the actual CREATE2:
        //   guardedSalt = keccak256(abi.encode(salt))
        // computeCreate2Address does NOT apply _guard, so we must pass the
        // guarded salt ourselves to get the correct prediction.
        bytes32 guardedSalt = keccak256(abi.encode(salt));
        address predicted = CREATEX.computeCreate2Address(guardedSalt, initCodeHash);
        console.log("Predicted EcoSwapGateway address:", predicted);

        // --- Skip if already deployed ---
        if (predicted.code.length > 0) {
            console.log("EcoSwapGateway already deployed at:", predicted);
            _writeResult(deployFilePath, predicted, portalAddress);
            return;
        }

        // --- Deploy ---
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate2(salt, initCode);
        vm.stopBroadcast();

        require(deployed == predicted, "Deployed address does not match prediction");
        console.log("EcoSwapGateway deployed at:", deployed);

        // --- Record result ---
        _writeResult(deployFilePath, deployed, portalAddress);
    }

    function _writeResult(string memory filePath, address deployed, address portal) internal {
        vm.writeLine(
            filePath,
            string(
                abi.encodePacked(
                    vm.toString(block.chainid),
                    ",",
                    vm.toString(deployed),
                    ",",
                    "contracts/EcoSwapGateway.sol:EcoSwapGateway",
                    ",",
                    vm.toString(abi.encode(portal))
                )
            )
        );
    }
}
