#!/usr/bin/env node

/**
 * AIOS Brain Chunker
 *
 * Story: WSB-1.2 - Brain Indexer (índice léxico com metadados de origem)
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Splits a file's content into semantically meaningful chunks that carry a
 * heading and a starting line number. Three strategies are applied based on
 * the file extension:
 *
 *   - Markdown (.md/.markdown): split by ATX headings (# .. ####). Oversized
 *     sections are further split by paragraph while keeping the parent heading.
 *   - Code (.js/.ts/.py/...): split into blocks of ~60 lines, heading is the
 *     file name plus the first significant line of the block.
 *   - Plain text (.txt / everything else): split by paragraph.
 *
 * Design constraints:
 * - Zero new dependencies (path only).
 * - Never throws: malformed input yields an empty array or best-effort chunks.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

/** Maximum size (chars) of a single chunk before it is split further. */
const MAX_CHUNK_CHARS = 1500;

/** Approximate number of source lines per code block. */
const CODE_BLOCK_LINES = 60;

/** Extensions treated as markdown. */
const MARKDOWN_EXT = new Set(['.md', '.markdown']);

/** Extensions treated as source code (block chunking). */
const CODE_EXT = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.yaml',
  '.yml',
  '.json',
]);

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Chunk a file's content according to its type.
 *
 * @param {string} filePath - Path of the file (used for extension + heading).
 * @param {string} content - Raw file content.
 * @returns {Array<{heading: string|null, text: string, startLine: number}>}
 */
function chunkFile(filePath, content) {
  if (!content || typeof content !== 'string') return [];
  const ext = path.extname(filePath || '').toLowerCase();

  if (MARKDOWN_EXT.has(ext)) return chunkMarkdown(content);
  if (CODE_EXT.has(ext)) return chunkCode(filePath, content);
  return chunkText(content);
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MARKDOWN STRATEGY
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Split markdown by ATX headings (levels 1-4). Content preceding the first
 * heading becomes a leading chunk with a null heading. Oversized sections are
 * paragraph-split while retaining their heading.
 *
 * @param {string} content - Markdown content.
 * @returns {Array<{heading: string|null, text: string, startLine: number}>}
 */
function chunkMarkdown(content) {
  const lines = content.split(/\r?\n/);
  const headingRe = /^(#{1,4})\s+(.*)$/;

  const sections = [];
  let current = { heading: null, startLine: 1, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const match = headingRe.exec(lines[i]);
    if (match) {
      // Flush the previous section if it has any content.
      if (current.lines.join('').trim().length > 0 || current.heading !== null) {
        sections.push(current);
      }
      current = { heading: match[2].trim(), startLine: i + 1, lines: [] };
    } else {
      current.lines.push(lines[i]);
    }
  }
  if (current.lines.join('').trim().length > 0 || current.heading !== null) {
    sections.push(current);
  }

  const chunks = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    const headerLine = section.heading ? `${section.heading}\n` : '';
    const combined = (headerLine + text).trim();
    if (!combined) continue;

    if (combined.length <= MAX_CHUNK_CHARS) {
      chunks.push({ heading: section.heading, text: combined, startLine: section.startLine });
    } else {
      // Split oversized section by paragraph, keeping the heading on each part.
      const parts = splitByParagraph(text, MAX_CHUNK_CHARS - headerLine.length);
      for (const part of parts) {
        chunks.push({
          heading: section.heading,
          text: (headerLine + part.text).trim(),
          startLine: section.startLine + part.lineOffset,
        });
      }
    }
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CODE STRATEGY
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Split source code into fixed-size line blocks. The heading is the file name
 * plus the first significant (non-empty, non-trivial-comment) line of the block.
 *
 * @param {string} filePath - Path of the source file.
 * @param {string} content - Source content.
 * @returns {Array<{heading: string|null, text: string, startLine: number}>}
 */
function chunkCode(filePath, content) {
  const fileName = path.basename(filePath || 'file');
  const lines = content.split(/\r?\n/);
  const chunks = [];

  for (let start = 0; start < lines.length; start += CODE_BLOCK_LINES) {
    const block = lines.slice(start, start + CODE_BLOCK_LINES);
    const text = block.join('\n').trim();
    if (!text) continue;

    const firstSignificant = block.find((l) => isSignificantCodeLine(l));
    const heading = firstSignificant
      ? `${fileName} — ${firstSignificant.trim().slice(0, 120)}`
      : fileName;

    chunks.push({ heading, text, startLine: start + 1 });
  }

  return chunks;
}

/**
 * A line is significant if it has real content and is not a pure comment
 * marker or delimiter.
 *
 * @param {string} line - Source line.
 * @returns {boolean}
 */
function isSignificantCodeLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(\/\/|#|\*|\/\*|<!--)/.test(trimmed)) return false;
  if (/^[{}()[\];,]+$/.test(trimmed)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              PLAIN TEXT STRATEGY
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Split plain text into paragraph-based chunks.
 *
 * @param {string} content - Text content.
 * @returns {Array<{heading: string|null, text: string, startLine: number}>}
 */
function chunkText(content) {
  const parts = splitByParagraph(content, MAX_CHUNK_CHARS);
  return parts
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ heading: null, text: p.text.trim(), startLine: p.lineOffset + 1 }));
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Group blank-line-separated paragraphs into chunks no larger than maxChars.
 * Tracks the line offset (0-based, relative to the input) where each chunk
 * begins so callers can compute absolute start lines.
 *
 * @param {string} text - Text to split.
 * @param {number} maxChars - Maximum chunk size in characters.
 * @returns {Array<{text: string, lineOffset: number}>}
 */
function splitByParagraph(text, maxChars) {
  const safeMax = Math.max(200, maxChars || MAX_CHUNK_CHARS);
  const lines = text.split(/\r?\n/);

  const paragraphs = [];
  let buf = [];
  let bufStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      if (buf.length) {
        paragraphs.push({ text: buf.join('\n'), lineOffset: bufStart });
        buf = [];
      }
    } else {
      if (!buf.length) bufStart = i;
      buf.push(lines[i]);
    }
  }
  if (buf.length) paragraphs.push({ text: buf.join('\n'), lineOffset: bufStart });

  // Merge consecutive paragraphs while staying under the size cap.
  const chunks = [];
  let currentText = '';
  let currentOffset = 0;
  for (const para of paragraphs) {
    if (!currentText) {
      currentText = para.text;
      currentOffset = para.lineOffset;
    } else if (currentText.length + para.text.length + 2 <= safeMax) {
      currentText += `\n\n${para.text}`;
    } else {
      chunks.push({ text: currentText, lineOffset: currentOffset });
      currentText = para.text;
      currentOffset = para.lineOffset;
    }

    // A single paragraph larger than the cap is hard-split by size.
    while (currentText.length > safeMax) {
      chunks.push({ text: currentText.slice(0, safeMax), lineOffset: currentOffset });
      currentText = currentText.slice(safeMax);
    }
  }
  if (currentText) chunks.push({ text: currentText, lineOffset: currentOffset });

  return chunks;
}

module.exports = {
  chunkFile,
  chunkMarkdown,
  chunkCode,
  chunkText,
  MAX_CHUNK_CHARS,
  CODE_BLOCK_LINES,
  MARKDOWN_EXT,
  CODE_EXT,
};
