// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {SwapIntent} from "../contracts/SwapIntent.sol";

contract DeploySwapIntent is Script {
    function run() external {
        address portalAddress = vm.envAddress("PORTAL_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        SwapIntent swapIntent = new SwapIntent(portalAddress);
        console.log("SwapIntent deployed at:", address(swapIntent));
        vm.stopBroadcast();
    }
}
