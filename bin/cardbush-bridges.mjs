#!/usr/bin/env node
import { main, reportError } from '../src/cli.mjs';
await main().catch(reportError);
