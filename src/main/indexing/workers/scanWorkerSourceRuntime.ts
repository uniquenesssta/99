export function scanWorkerSource(): string {
  return String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fontkit = require(workerData.fontkitPath);

const SCRIPT_DETECTION_VERSION = 2;
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);
const FONT_SCRIPT_SAMPLES = {
  latin: Array.from('AaZz0123456789').map((char) => char.codePointAt(0)),
  chinese: Array.from('中文汉字国体的一').map((char) => char.codePointAt(0)),
  japanese: Array.from('あいうえおアイウエオ日本語').map((char) => char.codePointAt(0)),
  korean: Array.from('한글가나다라마바사').map((char) => char.codePointAt(0)),
  symbol: Array.from('☑★♡←→').map((char) => char.codePointAt(0)),
  other: [],
  arabic: Array.from('العربية').map((char) => char.codePointAt(0)),
  hebrew: Array.from('עברית').map((char) => char.codePointAt(0)),
  thai: Array.from('ภาษาไทย').map((char) => char.codePointAt(0)),
  cyrillic: Array.from('Кириллица').map((char) => char.codePointAt(0)),
  greek: Array.from('Ελληνικά').map((char) => char.codePointAt(0)),
  devanagari: Array.from('हिन्दी').map((char) => char.codePointAt(0)),
  bengali: Array.from('বাংলা').map((char) => char.codePointAt(0)),
  tamil: Array.from('தமிழ்').map((char) => char.codePointAt(0)),
  telugu: Array.from('తెలుగు').map((char) => char.codePointAt(0)),
  gujarati: Array.from('ગુજરાતી').map((char) => char.codePointAt(0)),
  gurmukhi: Array.from('ਪੰਜਾਬੀ').map((char) => char.codePointAt(0)),
  lao: Array.from('ພາສາລາວ').map((char) => char.codePointAt(0)),
  khmer: Array.from('ភាសាខ្មែរ').map((char) => char.codePointAt(0)),
  myanmar: Array.from('မြန်မာ').map((char) => char.codePointAt(0)),
  ethiopic: Array.from('አማርኛ').map((char) => char.codePointAt(0)),
  armenian: Array.from('Հայերեն').map((char) => char.codePointAt(0)),
  georgian: Array.from('ქართული').map((char) => char.codePointAt(0)),
  vietnamese: Array.from('Tiếng Việt ăâêôơưđ').map((char) => char.codePointAt(0))
};

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function asFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ttf') return 'ttf';
  if (ext === '.otf') return 'otf';
  if (ext === '.ttc') return 'ttc';
  if (ext === '.otc') return 'otc';
  return 'unknown';
}

function hasValidFontSignatureSync(filePath) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buffer, 0, 4, 0);
    if (bytesRead < 4) return false;

    const tag = buffer.toString('binary');
    const numeric = buffer.readUInt32BE(0);
    return tag === 'OTTO' || tag === 'ttcf' || numeric === 0x00010000 || numeric === 0x74727565 || numeric === 0x74797031;
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function fontHasCodePoint(font, codePoint) {
  try {
    if (Array.isArray(font && font.characterSet) && font.characterSet.includes(codePoint)) return true;
    if (font && typeof font.hasGlyphForCodePoint === 'function') return !!font.hasGlyphForCodePoint(codePoint);
    if (font && typeof font.glyphForCodePoint === 'function') {
      const glyph = font.glyphForCodePoint(codePoint);
      return !!glyph && typeof glyph.id === 'number' && glyph.id > 0;
    }
  } catch {
    return false;
  }

  return false;
}

function openedFonts(opened) {
  return Array.isArray(opened && opened.fonts) && opened.fonts.length ? opened.fonts : [opened];
}

function collectCharacterSet(opened) {
  const codePoints = new Set();
  for (const font of openedFonts(opened)) {
    if (!Array.isArray(font && font.characterSet)) continue;
    for (const value of font.characterSet) {
      if (Number.isInteger(value) && value >= 0) codePoints.add(value);
    }
  }
  return codePoints;
}

function countCodePointsInRanges(codePoints, ranges) {
  let count = 0;
  for (const value of codePoints) {
    if (ranges.some(([start, end]) => value >= start && value <= end)) count += 1;
  }
  return count;
}

function hasAnySample(opened, samples) {
  const fonts = openedFonts(opened);
  return samples.some((codePoint) => fonts.some((font) => fontHasCodePoint(font, codePoint)));
}

function detectFontScriptsFromOpened(opened, textHint = '') {
  const hint = textHint.toLowerCase();
  const codePoints = collectCharacterSet(opened);
  const scripts = new Set();

  const latinCount = countCodePointsInRanges(codePoints, [[0x0020, 0x007e], [0x00a0, 0x024f]]);
  const cjkCount = countCodePointsInRanges(codePoints, [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]);
  const kanaCount = countCodePointsInRanges(codePoints, [[0x3040, 0x30ff], [0x31f0, 0x31ff]]);
  const hangulCount = countCodePointsInRanges(codePoints, [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7af]]);
  const symbolCount = countCodePointsInRanges(codePoints, [[0x2190, 0x27bf], [0xe000, 0xf8ff], [0x1f000, 0x1faff]]);

  const hasJapaneseHint = /(meiryo|yugoth|yu gothic|yu mincho|msgothic|ms gothic|msmincho|ms mincho|noto sans jp|source han sans jp|source han serif jp|japanese|jp\b)/i.test(hint);
  const hasKoreanHint = /(malgun|batang|gulim|dotum|gungsuh|korean|hangul|noto sans kr|source han sans kr|source han serif kr|kr\b)/i.test(hint);
  const hasChineseHint = /(yahei|simsun|simhei|fangsong|kaiti|songti|heiti|microsoft yahei|microsoft jhenghei|mingliu|pmingliu|dengxian|noto sans cjk sc|noto sans cjk tc|source han sans sc|source han sans tc|source han serif sc|source han serif tc|chinese|zh|cn\b|tw\b|hk\b|简体|繁體|中文|宋体|黑体|仿宋|楷体|雅黑|明体|明朝)/i.test(hint);
  const hasSymbolHint = /(symbol|wingdings|webdings|icons?|emoji|marlett|mdls?2|fluent icons?|assets)/i.test(hint);

  const isJapanese = kanaCount >= 40 || hasJapaneseHint;
  const isKorean = hangulCount >= 300 || hasKoreanHint;
  const isChinese = hasChineseHint || (cjkCount >= 500 && !isJapanese && !isKorean);
  const isSymbol = hasSymbolHint || (symbolCount >= 80 && cjkCount < 20 && kanaCount < 20 && hangulCount < 20 && latinCount < 80);

  if (isChinese) scripts.add('chinese');
  if (isJapanese) scripts.add('japanese');
  if (isKorean) scripts.add('korean');
  if (isSymbol) scripts.add('symbol');

  for (const [script, samples] of Object.entries(FONT_SCRIPT_SAMPLES)) {
    if (script === 'latin' || script === 'chinese' || script === 'japanese' || script === 'korean') continue;
    if (script === 'symbol' || script === 'other') continue;
    if (hasAnySample(opened, samples)) scripts.add(script);
  }

  const hasStrictNonLatin = Array.from(scripts).some((script) => script !== 'latin');
  const hasLatinAlphabet = latinCount >= 52 || hasAnySample(opened, FONT_SCRIPT_SAMPLES.latin);
  if (!hasStrictNonLatin && hasLatinAlphabet) scripts.add('latin');
  if (!scripts.size && codePoints.size) scripts.add('other');

  return Object.keys(FONT_SCRIPT_SAMPLES).concat(['symbol', 'other']).filter((script) => scripts.has(script));
}

function inferScriptsFromFontText(filePath, names) {
  const text = [filePath, names.family, names.fullName, names.postscriptName, names.style].join(' ').toLowerCase();
  const scripts = new Set();

  if (/[\u3040-\u30ff]/.test(text) || /(meiryo|yugoth|yu gothic|yu mincho|msgothic|ms gothic|msmincho|ms mincho|noto sans jp|source han sans jp|source han serif jp|japanese|jp\b)/i.test(text)) scripts.add('japanese');
  if (/[\uac00-\ud7af]/.test(text) || /(malgun|batang|gulim|dotum|gungsuh|korean|hangul|noto sans kr|source han sans kr|source han serif kr|kr\b)/i.test(text)) scripts.add('korean');
  if (/[\u4e00-\u9fff]/.test(text) || /(yahei|simsun|simhei|fangsong|kaiti|songti|heiti|microsoft yahei|microsoft jhenghei|mingliu|pmingliu|dengxian|noto sans cjk sc|noto sans cjk tc|source han sans sc|source han sans tc|source han serif sc|source han serif tc|chinese|zh|cn\b|tw\b|hk\b|简体|繁體|中文|宋体|黑体|仿宋|楷体|雅黑|明体|明朝)/i.test(text)) scripts.add('chinese');
  if (/(symbol|wingdings|webdings|icons?|emoji|marlett|mdls?2|fluent icons?|assets)/i.test(text)) scripts.add('symbol');
  if (/[\u0600-\u06ff]/.test(text) || /(arabic|arab)/i.test(text)) scripts.add('arabic');
  if (/[\u0590-\u05ff]/.test(text) || /hebrew/i.test(text)) scripts.add('hebrew');
  if (/[\u0e00-\u0e7f]/.test(text) || /thai/i.test(text)) scripts.add('thai');
  if (/[\u0400-\u04ff]/.test(text) || /(cyrillic|russian|ukrainian)/i.test(text)) scripts.add('cyrillic');
  if (/[\u0370-\u03ff]/.test(text) || /greek/i.test(text)) scripts.add('greek');
  if (/[\u0900-\u097f]/.test(text) || /(devanagari|hindi|sanskrit)/i.test(text)) scripts.add('devanagari');
  if (/[\u0980-\u09ff]/.test(text) || /bengali/i.test(text)) scripts.add('bengali');
  if (/[\u0b80-\u0bff]/.test(text) || /tamil/i.test(text)) scripts.add('tamil');
  if (/[\u0c00-\u0c7f]/.test(text) || /telugu/i.test(text)) scripts.add('telugu');
  if (/[\u0a80-\u0aff]/.test(text) || /gujarati/i.test(text)) scripts.add('gujarati');
  if (/[\u0a00-\u0a7f]/.test(text) || /gurmukhi|punjabi/i.test(text)) scripts.add('gurmukhi');
  if (/[\u0e80-\u0eff]/.test(text) || /lao/i.test(text)) scripts.add('lao');
  if (/[\u1780-\u17ff]/.test(text) || /khmer/i.test(text)) scripts.add('khmer');
  if (/[\u1000-\u109f]/.test(text) || /myanmar|burmese/i.test(text)) scripts.add('myanmar');
  if (/[\u1200-\u137f]/.test(text) || /ethiopic|amharic/i.test(text)) scripts.add('ethiopic');
  if (/[\u0530-\u058f]/.test(text) || /armenian/i.test(text)) scripts.add('armenian');
  if (/[\u10a0-\u10ff]/.test(text) || /georgian/i.test(text)) scripts.add('georgian');
  if (/tiếng việt|vietnamese|viet/i.test(text)) scripts.add('vietnamese');

  const nonLatin = Array.from(scripts).some((script) => script !== 'latin');
  if (!nonLatin && /[a-z]/i.test(text)) scripts.add('latin');

  return Array.from(scripts);
}

function normalizeRustNameHint(input) {
  if (!input || typeof input !== 'object') return null;
  const style = String(input.displaySubfamily || input.preferredSubfamily || input.subfamilyName || '').trim();
  const postscriptName = String(input.postscriptName || '').trim();
  const rawFamily = String(input.displayFamily || input.preferredFamily || input.familyName || '').trim();
  const rawFullName = String(input.fullName || [rawFamily, style].filter(Boolean).join(' ') || rawFamily || postscriptName || '').trim();
  const family = rawFamily || rawFullName || postscriptName;
  const fullName = rawFullName || family;
  if (!family && !fullName && !postscriptName) return null;
  return { family, fullName, postscriptName, style };
}

function normalizeRustScriptHint(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.scripts)) return null;
  const known = new Set(Object.keys(FONT_SCRIPT_SAMPLES).concat(['symbol', 'other']));
  const scripts = Array.from(new Set(input.scripts
    .filter((script) => typeof script === 'string')
    .map((script) => script.trim().toLowerCase())
    .filter((script) => known.has(script))));
  return scripts.length ? { scripts, rangeCount: Number(input.rangeCount || 0), sourceIndex: Number(input.sourceIndex || 0) } : null;
}

function normalizeRustStyleHint(input) {
  if (!input || typeof input !== 'object') return null;
  const style = {};
  if (Number.isFinite(Number(input.weightClass))) style.weightClass = Number(input.weightClass);
  if (Number.isFinite(Number(input.widthClass))) style.widthClass = Number(input.widthClass);
  if (Number.isFinite(Number(input.unitsPerEm))) style.unitsPerEm = Number(input.unitsPerEm);
  if (Number.isFinite(Number(input.glyphCount))) style.glyphCount = Number(input.glyphCount);
  if (typeof input.italic === 'boolean') style.italic = input.italic;
  if (typeof input.bold === 'boolean') style.bold = input.bold;
  if (typeof input.monospaced === 'boolean') style.monospaced = input.monospaced;
  return Object.keys(style).length ? style : null;
}


function normalizeRustFamilyHint(input) {
  if (!input || typeof input !== 'object') return null;
  const familyKey = String(input.familyKey || '').trim();
  const styleKey = String(input.styleKey || '').trim();
  const familyName = String(input.familyName || '').trim();
  const styleName = String(input.styleName || '').trim();
  if (!familyKey && !familyName) return null;
  return {
    familyName,
    styleName,
    familyKey,
    styleKey,
    weightClass: Number.isFinite(Number(input.weightClass)) ? Number(input.weightClass) : undefined,
    widthClass: Number.isFinite(Number(input.widthClass)) ? Number(input.widthClass) : undefined,
    italic: typeof input.italic === 'boolean' ? input.italic : undefined,
    bold: typeof input.bold === 'boolean' ? input.bold : undefined,
    monospaced: typeof input.monospaced === 'boolean' ? input.monospaced : undefined,
    sourceIndex: Number.isFinite(Number(input.sourceIndex)) ? Number(input.sourceIndex) : undefined
  };
}

function styleNameFromHint(styleHint, fallbackStyle) {
  const base = String(fallbackStyle || '').trim();
  if (!styleHint) return base;
  if (base) return base;
  const parts = [];
  const weight = Number(styleHint.weightClass || 0);
  if (weight >= 700 || styleHint.bold) parts.push('Bold');
  else if (weight > 0 && weight <= 300) parts.push('Light');
  if (styleHint.italic) parts.push('Italic');
  return parts.join(' ') || base;
}

function shouldUseRustMetadataFastPath() {
  const mode = String(process.env.HFM_RUST_METADATA_FAST || '1').trim().toLowerCase();
  return mode !== '0' && mode !== 'false' && mode !== 'off';
}

function shouldUseRustNameHintOnly() {
  const mode = String(process.env.HFM_RUST_NAME_HINT_ONLY || '0').trim().toLowerCase();
  return mode === '1' || mode === 'true' || mode === 'on';
}

function readFontMetadata(filePath, rustNameHint, rustScriptHint, rustStyleHint, rustFamilyHint) {
  const rustNames = normalizeRustNameHint(rustNameHint);
  const rustScripts = normalizeRustScriptHint(rustScriptHint);
  const rustStyle = normalizeRustStyleHint(rustStyleHint);
  const rustFamily = normalizeRustFamilyHint(rustFamilyHint);
  if (rustNames && rustScripts && shouldUseRustMetadataFastPath()) {
    return Object.assign({}, rustNames, { style: styleNameFromHint(rustStyle, rustNames.style), scripts: rustScripts.scripts, scriptVersion: SCRIPT_DETECTION_VERSION, familyKey: rustFamily && rustFamily.familyKey, styleKey: rustFamily && rustFamily.styleKey, familySource: rustFamily ? 'rust' : 'name' });
  }
  if (rustNames && shouldUseRustNameHintOnly()) {
    return Object.assign({}, rustNames, { style: styleNameFromHint(rustStyle, rustNames.style), scripts: rustScripts ? rustScripts.scripts : inferScriptsFromFontText(filePath, rustNames), scriptVersion: SCRIPT_DETECTION_VERSION, familyKey: rustFamily && rustFamily.familyKey, styleKey: rustFamily && rustFamily.styleKey, familySource: rustFamily ? 'rust' : 'name' });
  }

  try {
    const opened = fontkit.openSync(filePath);
    const font = Array.isArray(opened && opened.fonts) ? opened.fonts[0] : opened;
    const family = String((font && (font.familyName || font.fullName)) || (rustNames && rustNames.family) || path.parse(filePath).name || '');
    const fullName = String((font && font.fullName) || (rustNames && rustNames.fullName) || family || path.parse(filePath).name || '');
    const postscriptName = String((font && font.postscriptName) || (rustNames && rustNames.postscriptName) || '');
    const style = styleNameFromHint(rustStyle, String((font && (font.subfamilyName || font.styleName)) || (rustNames && rustNames.style) || ''));
    const names = { family, fullName, postscriptName, style };
    const detected = detectFontScriptsFromOpened(opened, [filePath, family, fullName, postscriptName, style].join(' '));
    const scripts = detected.length ? detected : (rustScripts ? rustScripts.scripts : inferScriptsFromFontText(filePath, names));
    return Object.assign({}, names, { scripts, scriptVersion: SCRIPT_DETECTION_VERSION, familyKey: rustFamily && rustFamily.familyKey, styleKey: rustFamily && rustFamily.styleKey, familySource: rustFamily ? 'rust' : 'fontkit' });
  } catch {
    const fallback = path.parse(filePath).name;
    const names = rustNames || { family: fallback, fullName: fallback, postscriptName: '', style: '' };
    return Object.assign({}, names, { scripts: rustScripts ? rustScripts.scripts : inferScriptsFromFontText(filePath, names), scriptVersion: SCRIPT_DETECTION_VERSION, familyKey: rustFamily && rustFamily.familyKey, styleKey: rustFamily && rustFamily.styleKey, familySource: rustFamily ? 'rust' : 'fallback' });
  }
}

function parseJob(job) {
  const filePath = job.filePath;

  if (job.signatureValid === false || (job.signatureValid !== true && !hasValidFontSignatureSync(filePath))) {
    return Object.assign({}, job, {
      status: 'bad',
      message: '不是有效字体签名，已跳过。'
    });
  }

  const id = sha1((job.cacheKey || filePath).toLowerCase() + '|' + job.fileSize + '|' + Math.round(job.modifiedAt));
  const names = readFontMetadata(filePath, job.nameHint, job.scriptHint, job.styleHint, job.familyHint);
  const item = Object.assign({
    id,
    path: filePath,
    fileName: path.basename(filePath)
  }, names, {
    format: job.formatHint || asFormat(filePath),
    fileSize: job.fileSize,
    modifiedAt: job.modifiedAt,
    createdAt: job.createdAt,
    addedAt: new Date().toISOString(),
    favorite: false,
    collectionIds: [],
    tagNames: [],
    localTagNames: [],
    systemInstalled: false,
    systemInstallMatches: [],
    active: false,
    deleteProtected: false
  });

  return Object.assign({}, job, {
    status: 'ok',
    font: item
  });
}

parentPort.on('message', (message) => {
  if (!message) return;

  if (message.type === 'parseBatch') {
    const jobs = Array.isArray(message.jobs) ? message.jobs : [];
    const results = [];
    for (const job of jobs) {
      try {
        results.push(parseJob(job));
      } catch (error) {
        results.push(Object.assign({}, job, {
          status: 'error',
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    parentPort.postMessage({ type: 'batch', results });
    return;
  }

  if (message.type !== 'parse') return;
  try {
    parentPort.postMessage(parseJob(message.job));
  } catch (error) {
    parentPort.postMessage(Object.assign({}, message.job, {
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }));
  }
});
`;
}

