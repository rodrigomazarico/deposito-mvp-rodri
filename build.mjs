import { cp, mkdir, rm } from "node:fs/promises";

const files = ["index.html", "app.js", "styles.css"];
await rm("public", { recursive: true, force: true });
await mkdir("public", { recursive: true });
await Promise.all(files.map((file) => cp(file, `public/${file}`)));
console.log(
  `Depósito MVP: archivos estáticos copiados a public/ (${files.length})`,
);
