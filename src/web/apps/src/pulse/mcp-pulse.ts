import '../shared/mcp-app.css';
import './mcp-pulse.css';

import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import pkg from '~/package.json';

import { handlePulseToolResult } from './handlePulseToolResult.js';

const app = new App({ name: 'Tableau MCP Pulse App', version: pkg.version });
app.ontoolresult = (result: CallToolResult) => {
  void handlePulseToolResult(app, result).catch((err) => {
    console.error('[mcp-pulse] Unhandled error in handlePulseToolResult:', err);
  });
};
app.connect();
