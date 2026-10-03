import { createHash } from "crypto";
import { generateProcessTokens } from "./processCredentials";
import { config } from "./config";
export type JwtValidationData = { algorithm: "RS256"; audience: string; issuer: string; publicKey: string };
export type CredentialState = { masterToken: string; clientToken: string; clientTokenHash: string; version: string; validation: JwtValidationData };
let state: CredentialState | null = null;
let attempts = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(path, config.enhasa.url), { ...init, signal: AbortSignal.timeout(config.enhasa.timeoutMs) });
  if (!response.ok) throw new Error("Enhasa bootstrap request failed with " + response.status);
  return response.json();
};
export const bootstrapOnce = async (): Promise<CredentialState> => {
  const validation = await request("/auth/validation-data", { headers: { "x-enhasa-boot-token": config.enhasa.bootToken } }) as JwtValidationData;
  const { masterToken, clientToken } = generateProcessTokens();
  const registration = await request("/internal/toma/credentials", {
    method: "POST",
    headers: { "content-type": "application/json", "x-enhasa-boot-token": config.enhasa.bootToken, "x-enhasa-service": "toma" },
    body: JSON.stringify({ masterToken, clientToken })
  }) as { version: string };
  state = { masterToken, clientToken, clientTokenHash: createHash("sha256").update(clientToken).digest("base64url"), version: registration.version, validation };
  attempts = 0;
  return state;
};
export const bootstrapUntilReady = async () => {
  for (;;) {
    try { await bootstrapOnce(); console.log("Toma bootstrap completed"); return; }
    catch (error) {
      attempts++;
      const base = Math.min(30000, 500 * 2 ** Math.min(attempts, 6));
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      console.error("Toma bootstrap failed; retrying in " + delay + "ms");
      await sleep(delay);
    }
  }
};
export const credentials = () => state;
export const clearCredentialsForTest = () => { state = null; };
