// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {GuardedExecutorHook} from "calibur/hooks/example/GuardedExecutorHook.sol";

contract HookDeployer {
    event Deployed(address hook, uint256 attempt);

    function deployUntilFlag(uint256 maxAttempts) external returns (address) {
        for (uint256 i = 0; i < maxAttempts; i++) {
            GuardedExecutorHook hook = new GuardedExecutorHook();
            address addr = address(hook);

            // Only bit 3 (BEFORE_EXECUTE) must be set; all other hook bits (0-2, 4) must be clear
            // 0x1F masks all 5 hook flag bits; we require exactly 0x08
            if (uint160(addr) & 0x1F == 0x08) {
                emit Deployed(addr, i);
                return addr;
            }
        }
        revert("No valid address found");
    }
}

contract DeployHook is Script {
    function run() external {
        vm.startBroadcast();

        HookDeployer deployer = new HookDeployer();
        console.log("Deployer:", address(deployer));

        address hookAddr = deployer.deployUntilFlag(500);
        console.log("Hook deployed at:", hookAddr);
        // forge-lint: disable-next-line(unsafe-typecast)
        console.log("Last byte:", uint8(uint160(hookAddr)));
        console.log("BEFORE_EXECUTE (bit 3):", uint160(hookAddr) & 0x08 == 0x08 ? "YES" : "NO");

        vm.stopBroadcast();
    }
}
