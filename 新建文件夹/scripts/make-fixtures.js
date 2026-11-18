'use strict';

/**
 * 生成成员导入用的测试夹具（fixture）
 *
 * 产物（scripts/fixtures/）：
 * - members-ok.xlsx    标准 .xlsx 结构：含 [Content_Types].xml、_rels、sharedStrings、sheet1（含稀疏单元格与 inlineStr）
 * - members-ok.csv     CSV 版成功用例
 * - members-mixed.csv  混合用例：重名跳过、姓名过短失败、口令过短失败、无口令（服务端生成临时口令）
 *
 * 用法：node scripts/make-fixtures.js
 */

const fs = require('node:fs');
const path = require('node:path');

const { createZip } = require('../lib/zip');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

/** XML 文本转义 */
function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20490" windowHeight="7620"/></bookViews>
<sheets><sheet name="成员名单" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="等线"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

/**
 * 用「共享字符串 + 稀疏单元格 + 内联字符串」构建一个真实结构的 sheet1.xml
 * @param {Array<Array<{col: string, type: 's'|'inlineStr'|'n', value: string|number}>>} rows
 */
function buildSheetXml(rows) {
  const body = rows
    .map((cells, index) => {
      const rowNumber = index + 1;
      const cellXml = cells
        .map((cell) => {
          if (cell.type === 's') {
            return `<c r="${cell.col}${rowNumber}" t="s"><v>${cell.value}</v></c>`;
          }
          if (cell.type === 'inlineStr') {
            return `<c r="${cell.col}${rowNumber}" t="inlineStr"><is><t xml:space="preserve">${xml(
              cell.value
            )}</t></is></c>`;
          }
          return `<c r="${cell.col}${rowNumber}"><v>${cell.value}</v></c>`;
        })
        .join('');
      return `<row r="${rowNumber}" spans="1:3">${cellXml}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:C${rows.length}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="13.5"/>
<sheetData>${body}</sheetData>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function buildSharedStrings(list) {
  const items = list
    .map((text) => `<si><t xml:space="preserve">${xml(text)}</t></si>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">${items}</sst>`;
}

/** 生成 members-ok.xlsx */
function buildOkXlsx() {
  // 共享字符串表（顺序即索引）
  const shared = [
    '姓名', // 0
    '初始口令', // 1
    '角色', // 2
    '导入甲', // 3
    'importpw01', // 4
    '普通成员', // 5
    '导入乙', // 6
    '管理员', // 7
    'importpw03', // 8
  ];
  const rows = [
    [
      { col: 'A', type: 's', value: 0 },
      { col: 'B', type: 's', value: 1 },
      { col: 'C', type: 's', value: 2 },
    ],
    [
      { col: 'A', type: 's', value: 3 },
      { col: 'B', type: 's', value: 4 },
      { col: 'C', type: 's', value: 5 },
    ],
    // 稀疏行：跳过 B 列（口令留空 → 服务端生成临时口令）
    [
      { col: 'A', type: 's', value: 6 },
      { col: 'C', type: 's', value: 7 },
    ],
    // 内联字符串（不走 sharedStrings）
    [
      { col: 'A', type: 'inlineStr', value: '导入丙' },
      { col: 'B', type: 's', value: 8 },
    ],
  ];

  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/sharedStrings.xml', data: buildSharedStrings(shared) },
    { name: 'xl/worksheets/sheet1.xml', data: buildSheetXml(rows) },
  ]);
}

const OK_CSV = `姓名,初始口令,角色
导入丁,importpw04,普通成员
导入戊,,普通成员
导入己,importpw06,
`;

const MIXED_CSV = `姓名,初始口令,角色
张三,importpw07,普通成员
导,importpw08,普通成员
导入庚,short,普通成员
导入辛,,普通成员
`;

/**
 * 写出全部夹具
 * @param {string} [dir] 输出目录
 * @returns {string[]} 生成的文件路径
 */
function writeFixtures(dir = FIXTURE_DIR) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const targets = [
    { name: 'members-ok.xlsx', data: buildOkXlsx() },
    { name: 'members-ok.csv', data: Buffer.from(`\uFEFF${OK_CSV}`, 'utf8') },
    { name: 'members-mixed.csv', data: Buffer.from(`\uFEFF${MIXED_CSV}`, 'utf8') },
  ];
  return targets.map((target) => {
    const file = path.join(dir, target.name);
    fs.writeFileSync(file, target.data);
    return file;
  });
}

if (require.main === module) {
  const files = writeFixtures();
  files.forEach((file) => console.log(`已生成: ${file}`));
}

module.exports = { writeFixtures, buildOkXlsx, FIXTURE_DIR };
