import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { logError } from "./errors.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const application = await createApplication(config);
  if (config.missing.length) {
    console.warn(JSON.stringify({ event: "configuration-incomplete", missing: config.missing }));
  }
  const server = application.app.listen(config.port, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "listening", port: config.port, configured: config.connection !== null }));
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
  server.on("error", (error) => {
    logError("server-failed", error);
    application.close();
    process.exitCode = 1;
  });
  const shutdown = () => {
    application.close();
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => { process.exit(1); }, 20_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(JSON.stringify({ event: "startup-failed", message: error.message }));
  } else {
    logError("startup-failed", error);
  }
  process.exitCode = 1;
});
