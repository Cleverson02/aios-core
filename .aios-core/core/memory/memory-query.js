#!/usr/bin/env node

/**
 * AIOS Memory Query
 *
 * Story: WSB-0.2 - Memory API Unificada
 * Epic: AIOX Cortex - Workspace Brain (WSB)
 *
 * Unified read-only query layer over the local AIOS memory stores. Provides
 * lexical (keyword-overlap) retrieval across gotchas, decision logs and story
 * files so that subagent context enrichment stops falling back to `null`.
 *
 * Consumers:
 * - execution/context-injector.js  → MemoryQuery#query(query, {limit})
 * - execution/subagent-dispatcher.js → MemoryQuery#getContextForAgent(agentId, task)
 *
 * Design constraints:
 * - Zero new dependencies (fs, path only; fast-glob is optional and guarded).
 * - Total graceful degradation: any missing store yields an empty result,
 *   never a throw, on the read path.
 *
 * @author @dev (Dex)
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════════
//                              CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  gotchasJsonPath: '.aios/gotchas.json',
  decisionLogsDir: '.ai',
  storiesGlob: 'docs/stories/**/*.md',
  storiesDir: 'docs/stories',
  // Minimum token length considered for lexical matching
  minTokenLength: 3,
  // Cap on story files scanned to keep queries bounded
  maxStoryFiles: 500,
};

// ═══════════════════════════════════════════════════════════════════════════════════
//                              MEMORY QUERY CLASS
// ═══════════════════════════════════════════════════════════════════════════════════

class MemoryQuery {
  /**
   * Create a new MemoryQuery instance
   *
   * @param {Object} [options] - Configuration options
   * @param {string} [options.projectRoot] - Project root path (defaults to cwd)
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              PUBLIC METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Query local memory stores using simple lexical keyword overlap.
   *
   * @param {string} queryString - Free-text query
   * @param {Object} [options] - Query options
   * @param {number} [options.limit=10] - Maximum number of results
   * @returns {Promise<Array<{type: string, content: string, summary: string, score: number}>>}
   *          Results ordered by descending score (score in range 0-1).
   */
  async query(queryString, { limit = 10 } = {}) {
    const queryTokens = this._tokenize(queryString);
    if (queryTokens.length === 0) {
      return [];
    }

    const candidates = [
      ...this._loadGotchaCandidates(),
      ...this._loadDecisionCandidates(),
      ...this._loadStoryCandidates(),
    ];

    const scored = [];
    for (const candidate of candidates) {
      const score = this._score(queryTokens, candidate.searchText);
      if (score > 0) {
        scored.push({
          type: candidate.type,
          content: candidate.content,
          summary: candidate.summary,
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit));
  }

  /**
   * Get relevant memory and suggested patterns for an agent/task.
   *
   * @param {string} agentId - Agent identifier (reserved for future filtering)
   * @param {string} taskDescription - Description of the task
   * @returns {Promise<{relevantMemory: Array, suggestedPatterns: Array}>}
   */
  async getContextForAgent(agentId, taskDescription) {
    const relevantMemory = await this.query(taskDescription || agentId || '', { limit: 5 });
    const suggestedPatterns = this._loadSuggestedPatterns();

    return { relevantMemory, suggestedPatterns };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              CANDIDATE SOURCES (PRIVATE)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Load gotcha candidates from .aios/gotchas.json
   * @private
   * @returns {Array<{type, content, summary, searchText}>}
   */
  _loadGotchaCandidates() {
    const filePath = path.join(this.projectRoot, CONFIG.gotchasJsonPath);
    const data = this._readJson(filePath);
    if (!data || !Array.isArray(data.gotchas)) {
      return [];
    }

    return data.gotchas.map((g) => {
      const title = g.title || 'Untitled Gotcha';
      const reason = g.reason || g.description || '';
      const summary = title;
      const content = reason ? `${title}: ${reason}` : title;
      const searchText = [
        title,
        reason,
        g.category || '',
        g.wrong || '',
        g.right || '',
        ...(Array.isArray(g.tags) ? g.tags : []),
        ...(Array.isArray(g.relatedFiles) ? g.relatedFiles : []),
      ].join(' ');

      return { type: 'gotcha', content, summary, searchText };
    });
  }

  /**
   * Load decision-log candidates from .ai/*.md (headers only)
   * @private
   * @returns {Array<{type, content, summary, searchText}>}
   */
  _loadDecisionCandidates() {
    const dir = path.join(this.projectRoot, CONFIG.decisionLogsDir);
    const files = this._listMarkdown(dir);
    const candidates = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const headers = this._extractHeaders(raw);
        const title = headers[0] || path.basename(file, '.md');
        candidates.push({
          type: 'decision',
          content: title,
          summary: title,
          searchText: [path.basename(file), ...headers].join(' '),
        });
      } catch {
        // Skip unreadable files (graceful degradation)
      }
    }

    return candidates;
  }

  /**
   * Load story-file candidates from docs/stories/**\/*.md (title/headers only)
   * @private
   * @returns {Array<{type, content, summary, searchText}>}
   */
  _loadStoryCandidates() {
    const files = this._listStoryFiles();
    const candidates = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const headers = this._extractHeaders(raw);
        if (headers.length === 0) {
          continue;
        }
        const title = headers[0];
        candidates.push({
          type: 'story',
          content: title,
          summary: title,
          searchText: headers.join(' '),
        });
      } catch {
        // Skip unreadable files (graceful degradation)
      }
    }

    return candidates;
  }

  /**
   * Best-effort load of learned workflow patterns.
   * Reuses workflow-intelligence/learning/pattern-store if loadable.
   * @private
   * @returns {Array}
   */
  _loadSuggestedPatterns() {
    try {
      const mod = require('../../workflow-intelligence/learning/pattern-store');
      const PatternStore = mod && mod.PatternStore;
      if (!PatternStore) {
        return [];
      }
      const store = new PatternStore();
      if (typeof store.getActivePatterns === 'function') {
        const patterns = store.getActivePatterns();
        return Array.isArray(patterns) ? patterns : [];
      }
      return [];
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              LEXICAL HELPERS (PRIVATE)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Tokenize text into unique lowercase keyword tokens.
   * @private
   * @param {string} text
   * @returns {string[]} Unique tokens
   */
  _tokenize(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }
    const matches = text.toLowerCase().match(/[a-z0-9]+/g) || [];
    const filtered = matches.filter((t) => t.length >= CONFIG.minTokenLength);
    return [...new Set(filtered)];
  }

  /**
   * Score a candidate by unique query-token overlap, normalized 0-1.
   * @private
   * @param {string[]} queryTokens - Unique query tokens
   * @param {string} candidateText - Candidate searchable text
   * @returns {number} Score in range 0-1
   */
  _score(queryTokens, candidateText) {
    if (queryTokens.length === 0) {
      return 0;
    }
    const candidateTokens = new Set(this._tokenize(candidateText));
    if (candidateTokens.size === 0) {
      return 0;
    }
    let matched = 0;
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) {
        matched++;
      }
    }
    return matched / queryTokens.length;
  }

  /**
   * Extract markdown header lines (text after leading '#').
   * @private
   * @param {string} raw - Raw markdown content
   * @returns {string[]} Header texts
   */
  _extractHeaders(raw) {
    const headers = [];
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^#{1,6}\s+(.*)$/);
      if (match) {
        const text = match[1].trim();
        if (text) {
          headers.push(text);
        }
      }
    }
    return headers;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //                              FILESYSTEM HELPERS (PRIVATE)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Read and parse a JSON file, returning null on any failure.
   * @private
   */
  _readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * List markdown files (non-recursive) in a directory.
   * @private
   * @returns {string[]} Absolute file paths
   */
  _listMarkdown(dir) {
    try {
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  /**
   * List story markdown files recursively under docs/stories.
   * Prefers fast-glob (already a dependency); falls back to a manual walk.
   * @private
   * @returns {string[]} Absolute file paths (bounded by maxStoryFiles)
   */
  _listStoryFiles() {
    const baseDir = path.join(this.projectRoot, CONFIG.storiesDir);
    if (!fs.existsSync(baseDir)) {
      return [];
    }

    try {
      const fg = require('fast-glob');
      const files = fg.sync(CONFIG.storiesGlob, {
        cwd: this.projectRoot,
        absolute: true,
        onlyFiles: true,
      });
      return files.slice(0, CONFIG.maxStoryFiles);
    } catch {
      return this._walkMarkdown(baseDir, CONFIG.maxStoryFiles);
    }
  }

  /**
   * Recursive markdown walk fallback.
   * @private
   * @returns {string[]}
   */
  _walkMarkdown(dir, cap) {
    const results = [];
    const stack = [dir];
    while (stack.length > 0 && results.length < cap) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          results.push(full);
          if (results.length >= cap) {
            break;
          }
        }
      }
    }
    return results;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════════

module.exports = MemoryQuery;
