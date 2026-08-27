import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  preset: "vercel",
  vercel: {
    functions: {
      runtime: "nodejs22.x",
      // Launching headless Chromium cold and rendering a page can take
      // longer than Vercel's default function timeout.
      maxDuration: 60,
    },
  },
  // @sparticuz/chromium ships its Chromium binary as brotli-compressed
  // archives read from disk at runtime (not `require`d), so the default
  // bundler tracing misses them — force a full copy of the package's files.
  traceDeps: ["@sparticuz/chromium*"],
});
