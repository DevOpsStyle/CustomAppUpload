import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/public/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../public/index.html", import.meta.url), new URL("index.html", destination));
