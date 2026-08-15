import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzePlans } from "./tools/analyzePlans.js";
import { registerArchiveFiles } from "./tools/archiveFiles.js";
import { registerCompactFile } from "./tools/compactFile.js";
import { registerListRepo } from "./tools/listRepo.js";
import { registerUpdateFile } from "./tools/updateFile.js";

/**
 * Build a configured server without binding a transport.
 *
 * Kept separate from index.ts so tests (and any embedding host) can construct a server and
 * attach an in-memory transport. Importing the stdio entry point would start listening on
 * stdin as a side effect.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "markdown-archive",
    version: "0.1.0",
  });

  registerListRepo(server);
  registerAnalyzePlans(server);
  registerArchiveFiles(server);
  registerCompactFile(server);
  registerUpdateFile(server);

  return server;
}
