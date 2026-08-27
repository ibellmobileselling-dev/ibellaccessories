import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig(async ({ command }) => {
  const plugins: import("vite").PluginOption[] = [
    tsConfigPaths(),
    tanstackStart({
      server: { entry: "server" },
    }),
    react(),
    tailwindcss(),
  ];

  if (command === "build") {
    const { nitro } = await import("nitro/vite");
    const nitroPlugins = nitro();
    if (Array.isArray(nitroPlugins)) {
      plugins.push(...nitroPlugins);
    } else {
      plugins.push(nitroPlugins);
    }
  }

  return {
    plugins,
    server: {
      host: "0.0.0.0",
      port: 5000,
      allowedHosts: true,
    },
  };
});
