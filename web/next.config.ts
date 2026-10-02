import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Milestone I.
   *
   * `lib/chain/adapter.ts` imports the COMPILED Treasury/MockERC20 artifacts from
   * `../contracts/out/...` rather than a hand-typed ABI, so the decoder cannot drift from the
   * contract it describes. Those files live above `web/`, and Turbopack refuses to resolve
   * anything outside the directory holding the lockfile — which is `web/` here. Without this the
   * investigation route fails to build with "Module not found" for the artifacts.
   *
   * Setting the root to the repository root puts the compiled contracts inside the module graph.
   * It is a resolution-scope change only: no bundling behaviour, output or aliasing changes.
   */
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;