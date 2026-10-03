import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export const loadEnvironment = (): string => {
  const processKeys = new Set(Object.keys(process.env));
  const environment = process.env.APP_ENV ?? process.env.ENV ?? process.env.NODE_ENV ?? "development";
  const files = [
    ".env",
    `.env.${environment}`,
    ".env.local",
    `.env.${environment}.local`,
  ];
  const values: Record<string, string> = {};
  for (const filename of files) {
    const fullPath = path.resolve(process.cwd(), filename);
    if (fs.existsSync(fullPath)) Object.assign(values, dotenv.parse(fs.readFileSync(fullPath)));
  }
  for (const [key, value] of Object.entries(values)) {
    if (!processKeys.has(key)) process.env[key] = value;
  }
  return environment;
};
