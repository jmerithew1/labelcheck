import type { NextConfig } from "next";

// No `output: "standalone"` — Railway runs `next start` from the full
// install, and standalone output is unused (it only logs warnings).
const nextConfig: NextConfig = {};

export default nextConfig;
