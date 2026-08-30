const fs = require("fs");
const {
  compileRuleAdapter,
  fetchDocument,
  absUrl,
  extractHtmlContent,
  cleanContent,
} = require("./lib/ruleadapter");

const TOC_SEL = "body > div.menu > div.border > ul > li > a";

(async () => {
  const rules = JSON.parse(fs.readFileSync("so-novel/bundle/rules/main.json", "utf8"));
  const rule = rules.find((r) => r.name === "笔趣阁365");
  const ch = rule.chapter;

  // 手动构造第一章节 URL（目录页解析）
  const tocUrl = "https://www.biquge365.net/newbook/040932/";
  const $toc = await fetchDocument(tocUrl, { retries: 1, timeout: 15000 });
  const firstHref = $toc(TOC_SEL).first().attr("href");
  console.log("first href:", firstHref);
  const chapUrl = absUrl(tocUrl, firstHref);
  console.log("chapter url:", chapUrl);

  // 抓章节页
  const $doc = await fetchDocument(chapUrl, { retries: 1, timeout: 15000 });
  const h1 = $doc("#neirong > h1").text();
  console.log("h1:", h1);
  const c = extractHtmlContent($doc, ch.content);
  console.log("content html len:", c.length);
  if (c.length) console.log("head:", c.slice(0, 400).replace(/\s+/g, " "));
  const cleaned = cleanContent(c, ch);
  console.log("cleaned len:", cleaned.length);
  if (cleaned.length) console.log("preview:", cleaned.slice(0, 200).replace(/\n/g, " "));
})();