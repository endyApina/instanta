import { readFile, writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

// Emit crawlable landing content without running a public SSR server.
const vite = await createServer({
  configFile: "web/vite.config.mts", server: { middlewareMode: true }, appType: "custom",
});
try {
  const { Landing } = await vite.ssrLoadModule("/src/Landing.tsx");
  const html = await readFile("dist/web/index.html", "utf8");
  await writeFile("dist/web/index.html", html.replace('<div id="root"></div>', `<div id="root">${renderToString(createElement(Landing))}</div>`));
} finally { await vite.close(); }
