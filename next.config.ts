import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  logging: { incomingRequests: false },
  serverExternalPackages: ["unpdf"],
  outputFileTracingIncludes: {
    "/*": ["./src/server/research/pdf-parser.worker.mjs", "./node_modules/unpdf/package.json", "./node_modules/unpdf/dist/**/*"],
  },
};

export default withWorkflow(nextConfig);
