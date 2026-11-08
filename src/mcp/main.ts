/**
 * The MCP stdio entry (owner, 2026-11-08). The installed app launches it
 * through `naipes --mcp` (electron/main.cjs: re-exec as Node with
 * NP_DATA_DIR pointing at the profile's data folder); from a checkout,
 * `pnpm mcp` (NP_DATA_DIR to choose the folder).
 *
 * stdout IS the protocol channel: nothing else may print to it, so any
 * stray console.log is redirected to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNaipesMcpServer } from "./server.ts";

console.log = (...args: unknown[]) => console.error(...args);

const version = process.env.NP_APP_VERSION ?? "dev";
const server = createNaipesMcpServer(version);
await server.connect(new StdioServerTransport());
