#!/usr/bin/env node
import { runCli } from "./cli.mjs";
import { configArg, isModuleConfig, runEmbedded } from "./embedded.mjs";

const argv = process.argv.slice(2);
const module = configArg(argv);
process.exitCode = module && isModuleConfig(module.path) ? await runEmbedded(module.path, module.rest) : await runCli(argv);
