import * as aquaSdk from "@1inch/aqua-sdk";
import type { Address, Hex } from "viem";
import { agentSignAndSubmit } from "../../web/lib/calibur-agent.ts";

export async function dockPosition(args: {
  maker: Address;
  aqua: Address;
  app: Address;
  strategyHash: Hex;
  tokens: Address[];
}): Promise<Hex> {
  const toAddr = (x: string) =>
    new (aquaSdk.Address as unknown as new (x: string) => unknown)(x);
  const toHex = (x: unknown) =>
    new (aquaSdk.HexString as unknown as new (x: string) => unknown)(
      String((x as { toString?: () => string })?.toString?.() ?? x),
    );
  const aqua = new (aquaSdk.AquaProtocolContract as unknown as new (x: unknown) => {
    dock: (a: unknown) => { to: Address; data: Hex; value: bigint };
  })(toAddr(args.aqua));
  const dockTx = aqua.dock({
    app: toAddr(args.app),
    strategyHash: toHex(args.strategyHash),
    tokens: args.tokens.map((t) => toAddr(t)),
  });
  const { txHash } = await agentSignAndSubmit(args.maker, [
    {
      to: dockTx.to as Address,
      value: BigInt(dockTx.value ?? 0),
      data: dockTx.data as Hex,
    },
  ]);
  return txHash;
}
