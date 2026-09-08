import { z } from "zod";

export interface TokenOpt {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  walletRaw?: string;
}

const ADDR = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address");

export const manualPairSchema = z
  .object({
    tokenA: ADDR,
    tokenB: ADDR,
  })
  .refine((p) => p.tokenA.toLowerCase() !== p.tokenB.toLowerCase(), {
    message: "Pair tokens must differ",
    path: ["tokenB"],
  });

export const pairKeyOf = (a?: string, b?: string) =>
  [(a ?? "").toLowerCase(), (b ?? "").toLowerCase()].sort().join("|");

export const formSchema = z
  .object({
    capital: ADDR,
    capitalAmount: z
      .string()
      .refine((v) => v !== "" && Number(v) > 0, "Enter a positive amount"),
    templates: z.array(z.string()).default([]),
    manualPairs: z.array(manualPairSchema).default([]),
    aggressive: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.templates.length === 0 && v.manualPairs.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Pick at least one template or add a manual pair",
        path: ["templates"],
      });
    }
    const seen = new Set<string>();
    v.manualPairs.forEach((p, i) => {
      const key = pairKeyOf(p.tokenA, p.tokenB);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Pair ${i + 1} duplicates another pair (even reversed)`,
          path: ["manualPairs", i, "tokenB"],
        });
      }
      seen.add(key);
    });
  });

export type FormValues = z.infer<typeof formSchema>;
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const WETH_BASE = "0x4200000000000000000000000000000000000006";
