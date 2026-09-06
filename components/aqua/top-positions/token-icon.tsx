import type { TopPositionToken } from "@/hooks/use-top-positions";

type TokenIconProps = {
  token?: TopPositionToken;
  size?: number;
};

export function TokenIcon({ token, size = 20 }: TokenIconProps) {
  if (token?.logoURI) {
    return (
      <img
        src={token.logoURI}
        alt={token.symbol ?? token.address}
        width={size}
        height={size}
        className="rounded-full object-cover bg-muted"
      />
    );
  }
  const label = token?.symbol?.slice(0, 1) ?? "?";
  return (
    <span
      className="flex items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-medium"
      style={{ width: size, height: size }}
    >
      {label}
    </span>
  );
}
