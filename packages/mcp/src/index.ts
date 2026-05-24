#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TraceOnError } from '@traceon/core';
import { handleVerify, verifyToolDefinition } from './verify.js';

const server = new Server(
  { name: 'traceon', version: '0.1.0' },
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
