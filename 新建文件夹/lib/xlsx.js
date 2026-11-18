'use strict';

/**
 * 零依赖 .xlsx 解析（只读第一个工作表，输出纯文本行）
 *
 * 解析路径：ZIP 中央目录 → zlib.inflateRawSync 解压 →
 *   xl/sharedStrings.xml（共享字符串）+ xl/worksheets/sheet1.xml（单元格）
 *
 * 支持的单元格类型：s（共享字符串）、inlineStr（内联字符串）、str（公式结果字符串）、
 *   n（数字）、b（布尔）、e（错误）。不支持的：合并单元格、多工作表、.xls 老格式。
 */

const { readZip } = require('./zip');

const DEFAULT_SHEET = 'xl/worksheets/sheet1.xml';

/** 反转义 XML 文本（&amp; 必须最后处理，避免二次解码） */
function decodeXmlText(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/_x000D_/g, '');
}

/** 读取属性值（兼容带前缀的元素） */
function attr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(attrs || '');
  return m ? m[1] : null;
}

/** 收集一段 XML 内所有 <t> 文本（兼容富文本 <r><t>…</t></r>） */
function collectText(inner) {
  let text = '';
  const re = /<(?:[A-Za-z0-9_.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?t>/g;
  let m = re.exec(inner || '');
  while (m) {
    text += decodeXmlText(m[1]);
    m = re.exec(inner || '');
  }
  return text;
}

/** 解析 sharedStrings.xml → string[] */
function parseSharedStrings(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_.-]+:)?si\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?si>)/g;
  let m = re.exec(xml);
  while (m) {
    out.push(collectText(m[2] || ''));
    m = re.exec(xml);
  }
  return out;
}

/** 单元格引用（如 "AB12"）→ 0 基列号 */
function columnIndexOfRef(ref, fallback) {
  const m = /^\$?([A-Za-z]{1,3})\$?\d*$/.exec(String(ref || ''));
  if (!m) return fallback;
  const letters = m[1].toUpperCase();
  let idx = 0;
  for (let i = 0; i < letters.length; i += 1) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/** 单元格 → 字符串值 */
function cellValue(type, inner, shared) {
  const vMatch = /<(?:[A-Za-z0-9_.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?v>/.exec(inner || '');
  const raw = vMatch ? decodeXmlText(vMatch[1]) : '';

  if (type === 's') {
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= shared.length) return '';
    return shared[idx];
  }
  if (type === 'inlineStr') return collectText(inner);
  if (type === 'b') {
    if (raw === '1') return 'TRUE';
    if (raw === '0') return 'FALSE';
    return raw;
  }
  // str / n / e / 未标注类型：原样返回文本形式
  return raw;
}

/**
 * 解析工作表 XML
 * @param {string} xml
 * @param {string[]} shared 共享字符串表
 * @returns {Array<{row: number, cells: string[]}>}
 */
function parseWorksheet(xml, shared) {
  const rows = [];
  const rowRe = /<(?:[A-Za-z0-9_.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?row>)/g;
  const cellRe = /<(?:[A-Za-z0-9_.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?c>)/g;

  let rowMatch = rowRe.exec(xml);
  let physicalRow = 0;
  while (rowMatch) {
    const rowAttrs = rowMatch[1];
    const rowNumber = Number(attr(rowAttrs, 'r')) || physicalRow + 1;
    physicalRow = rowNumber;
    const inner = rowMatch[2] || '';

    const cells = [];
    cellRe.lastIndex = 0;
    let cellMatch = cellRe.exec(inner);
    let cursor = 0;
    while (cellMatch) {
      const cellAttrs = cellMatch[1];
      const ref = attr(cellAttrs, 'r');
      const index = ref ? columnIndexOfRef(ref, cursor) : cursor;
      cursor = index + 1;
      cells[index] = cellValue(attr(cellAttrs, 't'), cellMatch[2] || '', shared);
      cellMatch = cellRe.exec(inner);
    }

    for (let i = 0; i < cells.length; i += 1) {
      if (cells[i] === undefined || cells[i] === null) cells[i] = '';
    }
    if (cells.length || inner.trim()) {
      rows.push({ row: rowNumber, cells });
    }
    rowMatch = rowRe.exec(xml);
  }
  return rows;
}

/** 从 workbook.xml + rels 解析出第一个工作表在包内的路径 */
function resolveFirstSheet(entries) {
  const workbook = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const sheetMatch = /<(?:[A-Za-z0-9_.-]+:)?sheet\b([^>]*?)\/?>/.exec(workbook.data.toString('utf8'));
    const rid = sheetMatch ? attr(sheetMatch[1], 'r:id') : null;
    if (rid) {
      const relRe = /<(?:[A-Za-z0-9_.-]+:)?Relationship\b([^>]*?)\/?>/g;
      const relXml = rels.data.toString('utf8');
      let m = relRe.exec(relXml);
      while (m) {
        if (attr(m[1], 'Id') === rid) {
          const target = attr(m[1], 'Target') || '';
          const normalized = target.startsWith('/')
            ? target.slice(1)
            : `xl/${target}`.replace(/\/\.\//g, '/');
          if (entries.has(normalized)) return normalized;
        }
        m = relRe.exec(relXml);
      }
    }
  }
  return DEFAULT_SHEET;
}

/**
 * 解析 .xlsx 为文本行
 * @param {Buffer} buffer 文件内容
 * @returns {Array<{row: number, cells: string[]}>}
 */
function parseXlsxRows(buffer) {
  const entries = readZip(buffer);
  if (!entries.has('[Content_Types].xml')) {
    throw new Error('缺少 [Content_Types].xml，不是标准的 .xlsx 文件');
  }

  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const shared = sharedEntry ? parseSharedStrings(sharedEntry.data.toString('utf8')) : [];

  const sheetName = resolveFirstSheet(entries);
  const sheetEntry = entries.get(sheetName);
  if (!sheetEntry) throw new Error('工作簿中没有找到工作表数据');

  return parseWorksheet(sheetEntry.data.toString('utf8'), shared);
}

module.exports = { parseXlsxRows, parseWorksheet, parseSharedStrings, decodeXmlText };
