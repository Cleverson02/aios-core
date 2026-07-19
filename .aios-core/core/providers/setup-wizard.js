/**
 * Provider Setup Wizard — post-install onboarding (Story WSB-4.4).
 *
 * `runSetup()` is an interactive, RE-RUNNABLE flow:
 *   1. Show the known providers and ask which ones the user wants to use now
 *      (numbers separated by commas).
 *   2. For each chosen provider without a resolvable key, offer to register one
 *      now (hidden input) or skip.
 *   3. Run a full availability check (refresh).
 *   4. Print a summary of what ended up available + the `aios next` hint.
 *
 * `--non-interactive` (CI): skip prompts, just run the check + summary.
 *
 * Zero new deps — native `readline` only; key values are never echoed or logged.
 *
 * @module core/providers/setup-wizard
 * @version 1.0.0
 * @created Story WSB-4.4 — Provider Setup
 */

const readline = require('readline');
const chalk = require('chalk');

const credentials = require('./credentials-store');
const availability = require('./availability');

/**
 * Run the interactive setup wizard.
 *
 * @param {Object} [options]
 * @param {boolean} [options.nonInteractive=false] - Skip prompts (CI mode).
 * @param {string} [options.cwd] - Project root for the availability cache.
 * @returns {Promise<number>} Exit code (0 = ok).
 */
async function runSetup({ nonInteractive = false, cwd } = {}) {
  const root = cwd || process.cwd();
  console.log(chalk.cyan.bold('\n🧠 AIOX — Setup de Providers\n'));

  if (nonInteractive) {
    return summarize(root, { headline: 'Modo não-interativo: apenas verificação.' });
  }

  const providers = credentials.KNOWN_PROVIDERS;
  const rl = makeInterface();

  try {
    // Step 1 — which providers to configure now.
    console.log('Providers disponíveis para configurar:');
    providers.forEach((p, i) => {
      const source = credentials.getKeySource(p);
      const tag = source ? chalk.green(`(chave via ${source})`) : chalk.dim('(sem chave)');
      console.log(`  ${chalk.bold(String(i + 1))}. ${p} ${tag}`);
    });

    const pick = await ask(
      rl,
      '\nQuais você quer usar agora? (números separados por vírgula, ou Enter para pular): ',
    );
    const chosen = parseSelection(pick, providers);

    // Step 2 — register a key for each chosen provider that lacks one.
    for (const provider of chosen) {
      if (credentials.getKey(provider)) {
        console.log(chalk.green(`✓ ${provider} já tem chave (env ou store) — mantendo.`));
        continue;
      }
      const wants = await ask(rl, `Cadastrar chave para ${chalk.bold(provider)} agora? (s/N): `);
      if (/^s|^y/i.test(wants.trim())) {
        const key = await askHidden(rl, `  Cole a API key de ${provider} (entrada oculta): `);
        if (key) {
          credentials.setKey(provider, key);
          console.log(chalk.green(`  ✓ Chave de ${provider} salva (chmod 600).`));
        } else {
          console.log(chalk.yellow('  • Nada informado — pulando.'));
        }
      } else {
        console.log(chalk.dim(`  • ${provider} pulado (configure depois com: aios providers set-key ${provider}).`));
      }
    }
  } finally {
    rl.close();
  }

  // Step 3 + 4 — check + summary.
  return summarize(root, { headline: 'Verificação final:' });
}

// ═══════════════════════════════════════════════════════════════════════════════════
//                              INTERNAL
// ═══════════════════════════════════════════════════════════════════════════════════

/**
 * Refresh availability and print a human summary. Shared by both modes.
 *
 * @param {string} cwd - Project root.
 * @param {Object} [opts]
 * @param {string} [opts.headline] - Optional headline line.
 * @returns {number} Exit code (0).
 */
function summarize(cwd, { headline } = {}) {
  if (headline) console.log(chalk.cyan(`\n${headline}\n`));

  const { providers } = availability.getAvailability({ cwd, refresh: true });
  const available = [];
  for (const [provider, rec] of Object.entries(providers)) {
    const mark = rec.available ? chalk.green('✓ disponível') : chalk.red('✗ indisponível');
    console.log(`  ${provider.padEnd(12)} ${mark}`);
    if (rec.available) available.push(provider);
  }

  console.log(
    available.length
      ? chalk.green(`\n✓ Ativos: ${available.join(', ')}.`)
      : chalk.yellow('\n• Nenhum provider disponível ainda — cadastre uma chave ou instale um CLI.'),
  );
  console.log(chalk.dim('Dica: rode ') + chalk.bold('aios next') + chalk.dim(' para o próximo passo.'));
  return 0;
}

/**
 * Create a readline interface bound to stdio, with a muted-output writer for
 * hidden prompts.
 * @returns {readline.Interface}
 */
function makeInterface() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl._writeToOutput = (str) => {
    if (!rl.stdoutMuted) rl.output.write(str);
  };
  return rl;
}

/**
 * Ask a visible question.
 * @param {readline.Interface} rl - Interface.
 * @param {string} query - Prompt.
 * @returns {Promise<string>}
 */
function ask(rl, query) {
  return new Promise((resolve) => {
    rl.stdoutMuted = false;
    rl.question(query, (answer) => resolve(String(answer || '')));
  });
}

/**
 * Ask a question whose typed answer is NOT echoed (for secrets).
 * @param {readline.Interface} rl - Interface.
 * @param {string} query - Prompt (printed visibly).
 * @returns {Promise<string>}
 */
function askHidden(rl, query) {
  return new Promise((resolve) => {
    rl.stdoutMuted = false;
    process.stdout.write(query);
    rl.stdoutMuted = true;
    rl.question('', (answer) => {
      rl.stdoutMuted = false;
      process.stdout.write('\n');
      resolve(String(answer || '').trim());
    });
  });
}

/**
 * Parse a comma-separated selection of 1-based indices into provider ids.
 * Unknown / out-of-range entries are ignored; result is de-duplicated in order.
 *
 * @param {string} input - Raw user input.
 * @param {string[]} providers - Ordered provider ids.
 * @returns {string[]}
 */
function parseSelection(input, providers) {
  const out = [];
  for (const part of String(input || '').split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= providers.length) {
      const provider = providers[n - 1];
      if (!out.includes(provider)) out.push(provider);
    }
  }
  return out;
}

module.exports = { runSetup, parseSelection };
