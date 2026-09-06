import type { NextConfig } from "next";

const BACKEND_URL = process.env.BACKEND_URL || "http://34.132.80.5:3001";

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  experimental: {
    inlineCss: true,
  },
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: `${BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
