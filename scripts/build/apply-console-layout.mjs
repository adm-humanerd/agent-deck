import fs from "node:fs/promises";

export async function applyConsoleLayout(html) {
  const css = await fs.readFile(
    new URL("../../src/deck/streamdeck-feel.css", import.meta.url),
    "utf8",
  );
  const start = html.indexOf(
    "/* Stream Deck Physical Hardware & Dynamic Keycap Styling */",
  );
  const end = html.indexOf("</style>", start);
  if (start >= 0 && end < 0)
    throw new Error("Console stylesheet closing tag missing");
  html =
    start >= 0
      ? html.slice(0, start) + css.trimEnd() + "\n" + html.slice(end)
      : html.replace("</style>", css.trimEnd() + "\n</style>");
  html = html.replace(
    'content="width=device-width, initial-scale=1"',
    'content="width=device-width, initial-scale=1, viewport-fit=cover"',
  );
  html = html.replace(
    'aria-label="아이패드 연결 설정"',
    'aria-label="기기 연결 주소 및 코드 보기"',
  );
  html = html.replace("<span>아이패드 연결</span>", "<span>기기 연결</span>");
  html = html.replace("‘아이패드 연결’을 열고", "‘기기 연결’을 열고");
  return html;
}
