#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidBoard,
  readSafeJson,
  serializeForHtmlScript,
} from "./board-lib.mjs";

// 렌더러는 fragment와 독립 실행형 HTML 두 모드만 허용한다.
const inputPath = process.argv[2];
const outputPath = process.argv[3];
const modeFlagIndex = process.argv.indexOf("--mode");
const mode = modeFlagIndex === -1 ? "standalone" : process.argv[modeFlagIndex + 1];
const extraArguments = process.argv.filter(
  (_, index) =>
    index > 2 &&
    index !== 3 &&
    index !== modeFlagIndex &&
    index !== modeFlagIndex + 1,
);

if (
  !inputPath ||
  !outputPath ||
  !["fragment", "standalone"].includes(mode) ||
  extraArguments.length > 0
) {
  console.error(
    "Usage: render-board.mjs <board.json> <output.html> --mode fragment|standalone",
  );
  process.exitCode = 2;
} else {
  try {
    const resolvedInputPath = resolve(inputPath);
    const resolvedOutputPath = resolve(outputPath);
    if (resolvedInputPath === resolvedOutputPath) {
      throw new Error("Input board and rendered output paths must be different");
    }
    const board = await readSafeJson(resolvedInputPath, resolvedInputPath);
    assertValidBoard(board);

    // 보드 해시와 render nonce를 결합해 같은 보드를 두 번 넣어도 ID가 충돌하지 않게 한다.
    const instanceId = `aqk-${createHash("sha256")
      .update(`${board.board.id}:${board.board.run_id}`)
      .digest("hex")
      .slice(0, 8)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const fragment = await renderFragment(board, instanceId);
    const output =
      mode === "fragment"
        ? fragment
        : renderStandalone(fragment, board.board.title, board.board.locale);
    if (
      mode === "fragment" &&
      Buffer.byteLength(output, "utf8") >= 2 * 1024 * 1024
    ) {
      throw new Error(
        "Rendered fragment exceeds the 2 MB inline visualization limit",
      );
    }

    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, output, "utf8");
    console.log(`Rendered ${mode} QA board: ${resolvedOutputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// 정적 자산의 두 안전 치환점에 검증된 JSON과 생성 ID만 주입한다.
async function renderFragment(board, instanceId) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDirectory, "../assets/board-fragment.html");
  const template = await readFile(templatePath, "utf8");
  const instanceMarker = "%%AQK_INSTANCE%%";
  const dataMarker = "%%AQK_BOARD_JSON%%";
  const localeMarker = "%%AQK_LOCALE%%";

  const instanceMarkerCount = template.split(instanceMarker).length - 1;
  const dataMarkerCount = template.split(dataMarker).length - 1;
  const localeMarkerCount = template.split(localeMarker).length - 1;
  if (
    instanceMarkerCount < 4 ||
    dataMarkerCount !== 1 ||
    localeMarkerCount !== 1
  ) {
    throw new Error(
      "Board fragment template must contain instance, locale, and data markers",
    );
  }

  return template
    .replaceAll(instanceMarker, instanceId)
    .replace(localeMarker, board.board.locale)
    .replace(dataMarker, serializeForHtmlScript(board));
}

// 독립 실행형 결과는 네트워크·폼·base URL을 막는 CSP를 포함한다.
function renderStandalone(fragment, title, locale) {
  const safeTitle = escapeHtml(title);
  const safeLocale = escapeHtml(locale);
  return `<!doctype html>
<html lang="${safeLocale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; media-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${safeTitle}</title>
  <style>
    :root {
      --background: #f5f7fb;
      --foreground: #172033;
      --card: #ffffff;
      --card-foreground: #172033;
      --primary: #1769e0;
      --primary-foreground: #ffffff;
      --secondary: #edf1f7;
      --secondary-foreground: #42506a;
      --muted: #e8edf5;
      --muted-foreground: #647187;
      --destructive: #c33c44;
      --border: #d8e0ec;
      --ring: #4a91ee;
      --viz-series-1: #2677d8;
      --viz-series-2: #198263;
      --viz-series-3: #b56b19;
    }
    body {
      background: var(--background);
      color: var(--foreground);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
    }
    main {
      margin: 0 auto;
      max-width: 1200px;
      padding: 24px;
    }
    h1 {
      font-weight: 500;
      margin: 0 0 20px;
    }
  </style>
</head>
<body>
<main>
  <h1>${safeTitle}</h1>
  ${fragment}
</main>
</body>
</html>
`;
}

// 문서 제목에만 필요한 최소 HTML 이스케이프를 수행한다.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
