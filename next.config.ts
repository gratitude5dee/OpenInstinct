import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@stripe/link-cli/dist/**/*"],
  },
  serverExternalPackages: ["@stripe/link-cli"],
};

export default withEve(nextConfig);
