"use strict";

/**
 * AS 统一错误类型，对应 AS-CONTRACT.md 2.8 错误信封。
 *
 * codes -> HTTP 状态，全部来自契约表格：
 *   BAD_REQUEST 400 / SOURCE_NOT_FOUND 404 / JOB_NOT_FOUND 404 /
 *   BOOK_NOT_FOUND 404 / SOURCE_ERROR 502 / TIMEOUT 504 / INTERNAL 500
 */
const HTTP_STATUS = {
  BAD_REQUEST: 400,
  SOURCE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  BOOK_NOT_FOUND: 404,
  SOURCE_ERROR: 502,
  TIMEOUT: 504,
  INTERNAL: 500,
};

class APIError extends Error {
  /**
   * @param {string} code 契约错误码
   * @param {string} message 人类可读信息
   * @param {object} [detail] 附加信息
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "APIError";
    this.code = code;
    this.detail = detail;
    this.status = HTTP_STATUS[code] ?? 500;
  }
}

/** 便捷构造 */
const fail = (code, message, detail) => new APIError(code, message, detail);

/**
 * 校验 bookId 规则（契约 4.1）：
 *   bookId = source + ":" + sourceId；source 仅 [a-z0-9_]；
 *   sourceId 禁止含 ":"（否则 400）。
 */
function assertBookId(source, sourceId) {
  if (typeof source !== "string" || !/^[a-z0-9_]+$/.test(source)) {
    throw fail("BAD_REQUEST", "source 非法：仅允许小写字母、数字、下划线");
  }
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw fail("BAD_REQUEST", "sourceId 不能为空");
  }
  if (sourceId.includes(":")) {
    throw fail("BAD_REQUEST", "sourceId 禁止包含冒号 ':'");
  }
}

/** 校验搜索入参（契约 2.3）：keyword 必填 <=200，page 从 1 起 */
function parseSearchParams(body) {
  const keyword = String((body && body.keyword) || "").trim();
  if (!keyword) throw fail("BAD_REQUEST", "keyword 必填");
  if (keyword.length > 200) throw fail("BAD_REQUEST", "keyword 不能超过 200 字符");

  let source = null;
  if (body.source !== undefined && body.source !== null && body.source !== "") {
    source = String(body.source);
  }

  let page = 1;
  if (body.page !== undefined && body.page !== null && body.page !== "") {
    page = Number(body.page);
    if (!Number.isInteger(page) || page < 1) {
      throw fail("BAD_REQUEST", "page 必须是 >=1 的整数");
    }
  }

  return { keyword, source, page };
}

/** 校验 download 入参（契约 2.4、4.1） */
function parseDownloadParams(body) {
  const source = String((body && body.source) || "");
  const sourceId = String((body && body.sourceId) || "");
  assertBookId(source, sourceId);
  const refresh = Boolean(body && body.refresh);
  return { source, sourceId, refresh };
}

/** 校验并切分 jobs 路径的参数 */
function parseJobRoute(jobId) {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 512) {
    throw fail("BAD_REQUEST", "jobId 非法");
  }
  return jobId;
}

// 保留 package exports 便于单测
module.exports = { APIError, fail, HTTP_STATUS, assertBookId, parseSearchParams, parseDownloadParams, parseJobRoute };