#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TraceOnError, shutdownEmbeddedBackend } from '@traceon/core';
import { handleVerify, verifyToolDefinition } from './verify.js';

// The embedded collector (when in use) is a server-lifetime subprocess.
// Stop it on shutdown so no orphan otelcol-contrib outlives the MCP server.
// No-op when the SigNoz backend is configured.
let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await shutdownEmbeddedBackend();
  } finally {
    process.exit(code);
  }
}
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));
// Claude closes the MCP server by closing stdin.
process.stdin.on('close', () => void shutdown(0));

const server = new Server(
  { name: 'traceon', version: '0.2.3' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [verifyToolDefinition],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'traceon_verify') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  try {
    const result = await handleVerify(request.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof TraceOnError) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(err.toJSON(), null, 2) }],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
