import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["bakong-khqr"],
  allowedDevOrigins: ['**.trycloudflare.com', '**.trycloudflare.com']
};

export default nextConfig;
