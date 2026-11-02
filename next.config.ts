import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // three-vrm은 ESM 패키지이므로 Next 번들러가 직접 변환하도록 지정
  transpilePackages: ["@pixiv/three-vrm"],
};

export default nextConfig;
