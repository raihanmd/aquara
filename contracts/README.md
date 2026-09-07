# Aqua EZ Contracts - GuardedExecutorHook (own copy)

Deploys our own copy of Calibur's `GuardedExecutorHook` on Base so the
agent whitelist is not hosted on a third-party deployment. Same code as
ALMA (`calibur/hooks/example/GuardedExecutorHook.sol`), reached via
foundry remappings - no vendored code here.

## Deploy

```bash
cd contracts
forge build
forge script script/DeployHook.s.sol \
  --rpc-url https://mainnet.base.org \
  --broadcast --verify
```

`forge` will prompt for your private key / keystore. Never commit keys.

The script brute-forces deployments until the hook address has exactly
the `BEFORE_EXECUTE` flag (`addr & 0x1F == 0x08`), otherwise Calibur
reverts with `InvalidHook`.

## After deploy

Copy the printed hook address into the frontend:

- `lib/delegation/constants.ts` → `GUARDED_EXECUTOR_HOOK`
- `lib/config.ts` (if mirroring)

Then re-delegate (register + setCanExecute + update) so keys point at
the new hook.
