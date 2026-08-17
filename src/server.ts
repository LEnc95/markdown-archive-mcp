import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzePlans } from "./tools/analyzePlans.js";
import { registerArchiveFiles } from "./tools/archiveFiles.js";
import { registerCompactFile } from "./tools/compactFile.js";
import { registerListRepo } from "./tools/listRepo.js";
import { registerRestoreFiles } from "./tools/restoreFiles.js";
import { registerUpdateFile } from "./tools/updateFile.js";

export const SERVER_NAME = "markdown-archive";
export const SERVER_VERSION = "0.2.1";

/**
 * Build a configured server without binding a transport.
 *
 * Kept separate from index.ts so tests (and any embedding host) can construct a server and
 * attach an in-memory transport. Importing the stdio entry point would start listening on
 * stdin as a side effect.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerListRepo(server);
  registerAnalyzePlans(server);
  registerArchiveFiles(server);
  registerRestoreFiles(server);
  registerCompactFile(server);
  registerUpdateFile(server);

  return server;
}
