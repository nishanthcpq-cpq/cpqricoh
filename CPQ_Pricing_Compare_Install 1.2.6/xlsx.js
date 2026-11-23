import {escapeXml} from './cpq.js';

const encoder = new TextEncoder();
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const table = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const data = [];
  const directory = [];
  let offset = 0;
  let directoryBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const bytes = encoder.encode(content);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 33, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(14, 33, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, bytes.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    data.push(local.buffer, name, bytes);
    directory.push(central.buffer, name);
    offset += 30 + name.length + bytes.length;
    directoryBytes += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  const count = directory.length / 2;
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, directoryBytes, true);
  end.setUint32(16, offset, true);
  return new Blob([...data, ...directory, end.buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

function chunks(value) {
  const result = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + 30_000, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(value.slice(start, end));
    start = end;
  }
  return result;
}

function worksheet(rows) {
  if (rows.length > 1_048_576) throw new Error('A report worksheet exceeds Excel’s row limit.');
  const sheetRows = rows.map((row, index) => {
    const rowNumber = index + 1;
    const cells = row.map((value, column) => {
      const text = escapeXml(String(value).replace(/_(?=x[0-9a-f]{4}_)/gi, '_x005F_'));
      const reference = String.fromCharCode(65 + column) + rowNumber;
      return '<c r="' + reference + '" t="inlineStr"><is><t xml:space="preserve">' + text + '</t></is></c>';
    });
    return '<row r="' + rowNumber + '">' + cells.join('') + '</row>';
  }).join('');
  return `<worksheet xmlns="${spreadsheet}">
    <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
    <cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/>
    <col min="3" max="4" width="32" customWidth="1"/><col min="5" max="5" width="36" customWidth="1"/></cols>
    <sheetData>${sheetRows}</sheetData><autoFilter ref="A1:E${rows.length}"/></worksheet>`;
}

export function makeWorkbook(rows) {
  const longValues = [['Doc Number', 'Attribute Name', 'Pricing', 'Part', 'Value']];
  const comparison = rows.map((row, rowIndex) => row.map((value, column) => {
    if (rowIndex === 0 || String(value).length <= 32_767) return value;
    const pieces = chunks(String(value));
    const firstRow = longValues.length + 1;
    pieces.forEach((piece, index) => longValues.push([
      row[0], row[1], rows[0][column], String(index + 1), piece
    ]));
    return '[Full value in Long Values, rows ' + firstRow + '–' +
      longValues.length + '; ' + value.length + ' characters]';
  }));
  const sheets = [{name: 'Comparison', rows: comparison}];
  if (longValues.length > 1) sheets.push({name: 'Long Values', rows: longValues});
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      ${sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')}
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${officeRel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRel}">${sheets.map((_, i) =>
      '<Relationship Id="rId' + (i + 1) + '" Type="' + officeRel + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('')}</Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${officeRel}"><bookViews><workbookView/></bookViews><sheets>
      ${sheets.map((sheet, i) => '<sheet name="' + sheet.name + '" sheetId="' +
        (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('')}
    </sheets></workbook>`
  };
  sheets.forEach((sheet, i) => { files['xl/worksheets/sheet' + (i + 1) + '.xml'] = worksheet(sheet.rows); });
  return zip(files);
}
