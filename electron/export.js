'use strict';

const fs = require('fs');
const path = require('path');
const { dialog, BrowserWindow } = require('electron');

const FILTERS = {
  csv: [{ name: 'CSV 파일', extensions: ['csv'] }],
  tsv: [{ name: 'TSV 파일', extensions: ['tsv'] }],
  xlsx: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }],
};

/** 저장 위치를 물어본다. 취소하면 null 을 돌려준다. */
async function askPath(defaultName, format) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const res = await dialog.showSaveDialog(win, {
    title: '내보내기',
    defaultPath: `${sanitize(defaultName)}.${format}`,
    filters: FILTERS[format] || FILTERS.csv,
  });
  return res.canceled ? null : res.filePath;
}

function sanitize(name) {
  return String(name || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function cellText(v, nullText) {
  if (v === null || v === undefined) return nullText;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** RFC 4180 기준으로 한 칸을 인용한다. */
function quote(text, delimiter) {
  if (text === '') return '';
  if (text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * @param {{name:string}[]} columns
 * @param {unknown[][]} rows
 * @param {{delimiter?:string, header?:boolean, nullText?:string, bom?:boolean}} opts
 */
function buildDelimited(columns, rows, opts = {}) {
  const delimiter = opts.delimiter ?? ',';
  const nullText = opts.nullText ?? '';
  const lines = [];
  if (opts.header !== false) {
    lines.push(columns.map((c) => quote(c.name, delimiter)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(row.map((v) => quote(cellText(v, nullText), delimiter)).join(delimiter));
  }
  // Excel 이 UTF-8 로 인식하도록 BOM 을 붙인다 (한글 깨짐 방지).
  return (opts.bom !== false ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

async function writeDelimited(filePath, columns, rows, opts) {
  await fs.promises.writeFile(filePath, buildDelimited(columns, rows, opts), 'utf8');
  return { filePath, rows: rows.length };
}

async function writeXlsx(filePath, sheetName, columns, rows, opts = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sanitizeSheetName(sheetName));

  ws.columns = columns.map((c) => ({
    header: c.name,
    key: c.name,
    width: Math.min(48, Math.max(10, c.name.length + 4)),
  }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const nullText = opts.nullText ?? '';
  for (const row of rows) {
    ws.addRow(row.map((v) => toExcelValue(v, nullText)));
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, columns.length) } };

  await wb.xlsx.writeFile(filePath);
  return { filePath, rows: rows.length };
}

/** 숫자로 읽을 수 있는 값은 숫자로 넣어 Excel 에서 계산할 수 있게 한다. */
function toExcelValue(v, nullText) {
  if (v === null || v === undefined) return nullText === '' ? null : nullText;
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function sanitizeSheetName(name) {
  return String(name || 'Sheet1').replace(/[\\/*?[\]:]/g, '_').slice(0, 31) || 'Sheet1';
}

/**
 * 결과를 파일로 저장한다.
 * @param {{columns:{name:string}[], rows:unknown[][], format:'csv'|'tsv'|'xlsx', defaultName:string, options?:object}} req
 */
async function exportRows(req) {
  const format = req.format === 'xlsx' ? 'xlsx' : req.format === 'tsv' ? 'tsv' : 'csv';
  const filePath = req.filePath || await askPath(req.defaultName, format);
  if (!filePath) return { canceled: true };

  const opts = { ...req.options };
  if (format === 'tsv') opts.delimiter = '\t';

  const result = format === 'xlsx'
    ? await writeXlsx(filePath, req.defaultName, req.columns, req.rows, opts)
    : await writeDelimited(filePath, req.columns, req.rows, opts);

  return { canceled: false, ...result, name: path.basename(filePath) };
}

module.exports = { exportRows, askPath, buildDelimited };
