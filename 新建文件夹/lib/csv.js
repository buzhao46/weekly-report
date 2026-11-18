'use strict';

/**
 * 极简 CSV 解析（零依赖）
 * 支持：BOM、CRLF/LF、双引号包裹字段、字段内逗号/换行、"" 转义。
 * 不支持：GBK 等非 UTF-8 编码（Excel 另存为「CSV UTF-8」即可）。
 */

/** Buffer → 文本（处理 BOM 与 UTF-16LE） */
function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

/**
 * 解析 CSV 文本为行
 * @param {string} text
 * @returns {Array<{row: number, cells: string[]}>} row 为 1 基物理行号
 */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let lineNumber = 1;
  const source = String(text || '');

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') lineNumber += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // 忽略，由 \n 触发换行
    } else if (ch === '\n') {
      row.push(field);
      rows.push({ row: lineNumber, cells: row });
      row = [];
      field = '';
      lineNumber += 1;
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push({ row: lineNumber, cells: row });
  }
  return rows;
}

module.exports = { parseCsvRows, decodeText };
