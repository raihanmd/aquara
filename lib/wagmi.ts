import { http, createConfig } from "wagmi";
import { base, robinhood } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const chains = [base, robinhood] as const;

export const config = createConfig({
  chains,
  connectors: [injected()],
  transports: {
    [base.id]: http(
      process.env.NEXT_PUBLIC_RPC_URL ||
        "https://lb.drpc.live/base/ApzzZ4_VREdElCiRmvIW2zKdznVRMDYR8aEIGrar0DFx",
    ),
    [robinhood.id]: http(
      process.env.NEXT_PUBLIC_RPC_URL_ROBINHOOD ||
        process.env.NEXT_PUBLIC_RPC_URL ||
        "https://rpc.mainnet.chain.robinhood.com",
    ),
  },
  ssr: true,
});
