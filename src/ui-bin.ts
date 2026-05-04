#!/usr/bin/env node
// Entry point for the detached UI server process.
import { startUIServer } from "./ui-server.js";

const port = parseInt(process.argv[2] || "7878", 10);
startUIServer(port);
// Keep stderr quiet (parent stdio is "ignore" anyway, but in case someone runs this directly).
console.error(`ClaudeLink UI listening on http://127.0.0.1:${port}`);
