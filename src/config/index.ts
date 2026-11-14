import { loadConfig, type EnvConfig } from "./env.js";

export const config: EnvConfig = loadConfig();
export * from "./env.js";
