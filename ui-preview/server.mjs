import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Serve only the preview and production UI assets, never reports or saved pages.
const files = new Map([
  ["/njggt/app/home", ["index.html", "text/html"]],
  ["/preview.js", ["preview.js", "text/javascript"]],
  ["/preview.css", ["preview.css", "text/css"]],
  ...["content.js", "report-format.js", "content.css"].map(name => [`/${name}`, [`../edge-extension/${name}`, name.endsWith("css") ? "text/css" : "text/javascript"]])
]);
createServer(async (request, response) => {
  if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
  const file = files.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (!file) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": `${file[1]}; charset=utf-8`, "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"
    }).end(body);
  } catch { response.writeHead(500).end("Preview asset unavailable"); }
}).listen(8798, "127.0.0.1", () => console.log("UI preview: http://127.0.0.1:8798/njggt/app/home"));
