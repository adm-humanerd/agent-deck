// Original neutral letter badges, not vendor logos. Distributed under the project MIT license.
const groups = {
  agy: ['antigravity', 'agy', 'antigravity-cli'],
  pi: ['pi', 'herdr:pi'], codex: ['codex'], gjc: ['gjc', 'gajae-code', 'gajae_code'],
  claude: ['claude', 'claude-code', 'claude_code', 'anthropic'],
  cursor: ['cursor', 'cursor-agent', 'cursor_agent', 'anysphere'],
  copilot: ['copilot', 'github-copilot', 'github_copilot', 'ghcs'],
  gemini: ['gemini', 'google-gemini', 'gemini-cli'],
  opencode: ['opencode', 'open-code', 'herdr:opencode', 'goose'],
  ollama: ['ollama', 'ollama-cli'], qoder: ['qoder', 'qodercli', 'qoderclicn', 'qodercn'],
  kiro: ['kiro', 'kiro-cli'], grok: ['grok', 'grok-build', 'xai'],
  kimi: ['kimi', 'kimi-code', 'kimi-cli', 'moonshot'], mastracode: ['mastracode', 'mastra'],
  amp: ['amp', 'amp-local', 'ampp'], muse: ['muse', 'muse-code', 'muse-cli'],
  hermes: ['hermes', 'hermes-agent', 'hermes-cli'], herdr: ['herdr', 'herdr-app', 'herdr-core'],
  paseo: ['paseo', 'paseo-advisor', 'paseo-committee', 'paseo-loop'],
  orca: ['orca', 'orca-agent'], pparit: ['pparit', '빠릿', 'parit'],
  t3: ['t3', 't3code', 't3-code', 't3_code'], 'prime-agent': ['prime-agent', 'prime', 'prime_agent']
};
const aliases = Object.fromEntries(Object.entries(groups).flatMap(([id, names]) => names.map(name => [name, id])));
export function agentIconName(app) {
  const key = typeof app === 'string' ? app.trim().toLowerCase() : '';
  return Object.hasOwn(aliases, key) ? aliases[key] : 'terminal';
}
const labels = {agy:'AG', pi:'PI', codex:'CX', gjc:'GJ', claude:'CL', cursor:'CU', copilot:'CP', gemini:'GE', opencode:'OC', ollama:'OL', qoder:'QO', kiro:'KI', grok:'GR', kimi:'KM', mastracode:'MA', amp:'AM', muse:'MU', hermes:'HE', herdr:'HD', paseo:'PA', orca:'OR', pparit:'PP', t3:'T3', 'prime-agent':'PR'};
export async function applyAgentIcons(html) {
  const anchor = /const agentLogoSvgs=([^\n]+);/;
  if (!anchor.test(html)) throw Error('Agent icon map missing');
  // Regenerate the entire map: never carry unreviewed embedded graphics forward.
  const icons = Object.fromEntries(Object.entries(labels).map(([id, label]) => [id,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" preserveAspectRatio="xMidYMid meet"><rect x="12" y="12" width="104" height="104" rx="20" fill="#202624" stroke="#b9e8ce" stroke-width="3"/><text x="64" y="66" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="38" font-weight="600" fill="#e8f1eb" stroke="none">' + label + '</text></svg>'
  ]));
  html = html.replace(anchor, () => 'const agentLogoSvgs=' + JSON.stringify(icons) + ';');
  const aliasDecl = 'const agentAliases = ' + JSON.stringify(aliases) + ';\nfunction agentIconName(app) { const key = typeof app === "string" ? app.trim().toLowerCase() : ""; return Object.hasOwn(agentAliases, key) ? agentAliases[key] : "terminal"; }\n';
  const end = html.indexOf('function icon(name,');
  const start = html.indexOf('const agentAliases =');
  const fn = html.indexOf('function agentIconName(');
  const begin = start !== -1 && start < end ? start : fn !== -1 && fn < end ? fn : end;
  if (end === -1) throw Error('Icon renderer missing');
  html = html.slice(0, begin) + aliasDecl + html.slice(end);
  html = html.replaceAll("symbol:['pi','codex','agy'].includes(s.app)?s.app:'terminal'", 'symbol:agentIconName(s.app)');
  html = html.replaceAll("symbol:['codex','agy','pi'].includes(x.agent)?x.agent:'terminal'", 'symbol:agentIconName(x.agent)');
  return html;
}
