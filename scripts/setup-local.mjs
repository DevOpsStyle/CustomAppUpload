import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const target = new URL("../.env", import.meta.url);
try {
  await copyFile(new URL("../.env.example", import.meta.url), target, constants.COPYFILE_EXCL);
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
}
const content = await readFile(target, "utf8");
if (/^SESSION_SECRET=\s*$/m.test(content)) {
  await writeFile(
    target,
    content.replace(/^SESSION_SECRET=[ \t]*$/m, `SESSION_SECRET=${randomBytes(48).toString("base64url")}`),
    { mode: 0o600 },
  );
  console.log("SESSION_SECRET generato in .env. Il valore non viene mostrato.");
} else {
  console.log("SESSION_SECRET gia' presente: mantenuto senza modifiche.");
}
