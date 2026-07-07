// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Deployed to GitHub Pages as a project site at https://<user>.github.io/evetreemap/
// The base path must match the repository name so asset URLs resolve correctly.
export default defineConfig({
  base: "/evetreemap/",
  plugins: [react()],
});
