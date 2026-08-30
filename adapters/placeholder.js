"use strict";

// 占位书源：用于全链路联调（AS-CONTRACT.md 5.4 原文实现）

module.exports = {
  id: "placeholder",
  name: "占位书源",
  enabled: true,

  /** 搜索：返回固定 3 本假书 */
  async search({ keyword, page }) {
    return [0, 1, 2].map((i) => ({
      sourceId: `p${page}_${i}`,
      title: `${keyword} · 示例书 ${i + 1}`,
      author: "示例作者",
      intro: "占位书源生成的假书，用于全链路联调。",
      category: "测试",
      status: "连载中",
      lastUpdate: new Date().toISOString().slice(0, 10),
      totalChapters: 128,
      words: 128 * 500,
    }));
  },

  async getBookInfo(sourceId) {
    return null;
  },

  async getCatalog(sourceId) {
    const n = 128; // 固定 128 章
    return Array.from({ length: n }, (_, i) => ({ index: i, title: `第 ${i + 1} 章 示例章节` }));
  },

  async getChapter(sourceId, index) {
    return `这是 ${sourceId} 的第 ${index + 1} 章正文。

段落二……`;
  },

  async getCover(sourceId) {
    return null;
  },
};