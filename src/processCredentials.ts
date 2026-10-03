import { randomBytes } from "crypto";
export const generateProcessTokens = () => ({
  masterToken: randomBytes(32).toString("base64url"),
  clientToken: randomBytes(32).toString("base64url")
});
