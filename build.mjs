/**
 * One source, two homes.
 *
 * `iron-ledger.html` is the app body: no doctype, no <head>, because the
 * Claude Artifact publisher supplies those. This script wraps that same file
 * in a real document for the standalone Vercel deployment, adding the PWA
 * plumbing an artifact doesn't need — manifest, icons, theme colours, service
 * worker registration.
 *
 * Run: npm run build
 */
import { readFile, writeFile } from "node:fs/promises";

const SRC = "iron-ledger.html";
const OUT = "public/index.html";

const src = await readFile(SRC, "utf8");

// Everything up to and including </style> belongs in <head>; the rest is body.
const split = src.indexOf("</style>");
if (split === -1) {
  console.error(`${SRC}: no </style> found — cannot tell head from body.`);
  process.exit(1);
}
const head = src.slice(0, split + "</style>".length).trim();
const body = src.slice(split + "</style>".length).trim();

if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(src)) {
  console.error(
    `${SRC} contains a doctype/html/head/body tag. It must not — the artifact ` +
      `publisher adds those, and this script adds them for the web build.`
  );
  process.exit(1);
}

const out = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#E4E3DE">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121416">
<meta name="description" content="Training and household accountability. Blunt on purpose.">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ledger">
${head}
</head>
<body>
${body}
<script>
if ("serviceWorker" in navigator) {
  addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
}
</script>
</body>
</html>
`;

await writeFile(OUT, out, "utf8");
console.log(`${OUT} written — ${(out.length / 1024).toFixed(1)} KB`);
