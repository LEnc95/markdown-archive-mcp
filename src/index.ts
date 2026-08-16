#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export { createServer } from "./server.js";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server for maintaining a markdown knowledge base. It classifies plans,
archives completed docs into a .archiveMD/ recycle bin, and compacts noisy
files. It never deletes anything.

This is not an interactive CLI. It speaks the Model Context Protocol over
stdin/stdout and is meant to be launched by an MCP client, which restarts it
as needed. Running it in a terminal will simply wait for protocol traffic.

  Register with Claude Code:
    claude mcp add --scope user markdown-archive -- npx -y markdown-archive-mcp

  Or add to any MCP client config:
    {"mcpServers":{"markdown-archive":{"command":"npx","args":["-y","markdown-archive-mcp"]}}}

Tools (each takes an absolute root_path):
  md_list_repo       list markdown files with size and last-touched date
  md_analyze_plans   classify as ACTIVE/COMPLETED/STALE/UNKNOWN, with evidence
  md_archive_files   move explicit paths into .archiveMD/, never deleting
  md_compact_file    return a compacted version without writing it
  md_update_file     write a change and report a diff summary

Options:
  -h, --help       show this message
  -v, --version    print the version

Docs: https://github.com/LEnc95/markdown-archive-mcp
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Someone running the binary by hand deserves an explanation rather than a process that
  // appears to hang while it waits on stdin.
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol; anything human-readable must go to stderr.
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
