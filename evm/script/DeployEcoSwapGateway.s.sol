// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {EcoSwapGateway} from "../contracts/EcoSwapGateway.sol";

contract DeployEcoSwapGateway is Script {
    function run() external {
        address portalAddress = vm.envAddress("PORTAL_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        EcoSwapGateway ecoSwapGateway = new EcoSwapGateway(portalAddress);
        console.log("EcoSwapGateway deployed at:", address(ecoSwapGateway));
        vm.stopBroadcast();
    }
}
