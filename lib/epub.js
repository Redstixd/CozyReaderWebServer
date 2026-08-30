"use strict";

const JSZip = require("jszip");

/**
 * EPUB 3 生成（AS-CONTRACT.md 第 3 节）。
 *
 * 结构：
 *   {sourceId}.epub
 *   ├─ mimetype                 (application/epub+zip, STORED, 第一个条目)
 *   ├─ META-INF/container.xml
 *   ├─ OEBPS/content.opf        (metadata + manifest + spine)
 *   ├─ OEBPS/toc.ncx            (目录)
 *   ├─ OEBPS/titles.xhtml       (封面/书名页)
 *   └─ OEBPS/chapters/{0001..N}.xhtml
 *
 * 章 XHTML：<h1>标题</h1> + 若干 <p>；正文纯文本（XML 转义），\n\n 合并成 <p>，空段落丢弃。
 */

function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 文本 → <p> 段落（\n\n 合并成 <p>，空段落丢弃） */
function paragraphs(text) {
  const raw = String(text || "");
  const blocks = raw.split(/\n{2,}/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  return blocks;
}

function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function chapterXhtml(title, text) {
  const ps = paragraphs(text).map((p) => `    <p>${escapeXml(p)}</p>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title></head>
<body>
  <h1>${escapeXml(title)}</h1>
${ps}
</body>
</html>`;
}

function titlesXhtml(meta) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(meta.title)}</title></head>
<body>
  <h1>${escapeXml(meta.title)}</h1>
  <p>${escapeXml(meta.author || "")}</p>
</body>
</html>`;
}

function contentOpf(meta, chapters) {
  const manifest = [];
  manifest.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  manifest.push(`    <item id="titles" href="titles.xhtml" media-type="application/xhtml+xml"/>`);
  chapters.forEach((ch, i) => {
    const id = `ch${String(i + 1).padStart(4, "0")}`;
    manifest.push(`    <item id="${id}" href="chapters/${String(i + 1).padStart(4, "0")}.xhtml" media-type="application/xhtml+xml"/>`);
  });
  const spine = [`    <itemref idref="titles"/>`];
  chapters.forEach((_, i) => {
    spine.push(`    <itemref idref="ch${String(i + 1).padStart(4, "0")}"/>`);
  });
  const metaTags = [
    `    <meta property="source">${escapeXml(meta.source || "")}</meta>`,
    `    <meta property="sourceId">${escapeXml(meta.sourceId || "")}</meta>`,
    `    <meta property="totalChapters">${Number(meta.totalChapters) || chapters.length}</meta>`,
  ];
  if (meta.status) metaTags.push(`    <meta property="status">${escapeXml(meta.status)}</meta>`);
  if (meta.category) metaTags.push(`    <meta property="category">${escapeXml(meta.category)}</meta>`);
  if (meta.words) metaTags.push(`    <meta property="words">${escapeXml(String(meta.words))}</meta>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(meta.bookId)}</dc:identifier>
    <dc:title>${escapeXml(meta.title || "")}</dc:title>
    <dc:creator>${escapeXml(meta.author || "")}</dc:creator>
    <dc:language>zh-CN</dc:language>
    ${meta.date ? `<dc:date>${escapeXml(meta.date)}</dc:date>` : ""}
    <meta property="dcterms:modified">${escapeXml(new Date().toISOString())}</meta>
${metaTags.join("\n")}
  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine toc="ncx">
${spine.join("\n")}
  </spine>
</package>`;
}

function tocNcx(meta, chapters) {
  const nav = chapters
    .map(
      (ch, i) => `    <navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
      <content src="chapters/${String(i + 1).padStart(4, "0")}.xhtml"/>
    </navPoint>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(meta.bookId)}"/>
  </head>
  <docTitle><text>${escapeXml(meta.title || "")}</text></docTitle>
  <navMap>
${nav}
  </navMap>
</ncx>`;
}

/**
 * 生成 EPUB Buffer。
 * @param {object} meta { bookId, title, author, date, source, sourceId, totalChapters, status, category, words }
 * @param {Array<{title,text}>} chapters 按顺序
 * @returns {Promise<Buffer>}
 */
async function buildEpub(meta, chapters) {
  const zip = new JSZip();
  // 约束：mimetype 必须 STORED 且为第一个条目（否则部分 EPUB 解析器拒绝）
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.folder("META-INF").file("container.xml", containerXml());
  const oebps = zip.folder("OEBPS");
  oebps.file("content.opf", contentOpf(meta, chapters));
  oebps.file("toc.ncx", tocNcx(meta, chapters));
  oebps.file("titles.xhtml", titlesXhtml(meta));
  const chDir = oebps.folder("chapters");
  chapters.forEach((ch, i) => {
    chDir.file(`${String(i + 1).padStart(4, "0")}.xhtml`, chapterXhtml(ch.title, ch.text));
  });
  return zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

module.exports = { buildEpub, escapeXml, paragraphs };