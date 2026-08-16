// Component definitions — the ONE list of vendored upstream presets
// (搬运机器). Shared by:
//   sync-templates.mjs   dev-side mirror sync (third-party/ → desktop/presets/)
//   upstream-update.cjs  runtime GUI updates (GitHub → ~/.dsh/upstream-snapshots/)
//   preset-gen.cjs       installers (snapshot-first, bundled-template fallback)
//
// Each entry is a preset that ships as a verbatim upstream snapshot plus a
// SINGLE transparent machine adaptation at install time (see adapter).
'use strict'

const COMPONENTS = {
  'anchored-standard': {
    label: '锚定（anchored-standard）',
    repo: 'https://github.com/xiaobright/dsh-anchored-standard.git',
    files: [
      'preset/agent.cordis.yml', 'preset/preset.yml',
      'preset/tool-bootstrap.mjs', 'preset/compaction-epoch.mjs',
      'preset/custom-bash.mjs', 'preset/dev-tool-search.mjs',
      'preset/instruction-hint.mjs', 'preset/skill-search.mjs',
      'LICENSE', 'NOTICE',
    ].map((p) => ({ src: p, name: p.replace(/^preset\//, '') })),
    adapter: 'anchored-bashPath',
    manifestNote: '第三方实验预设，逐字搬运（效果与故障归上游）。安装时仅替换 agent.cordis.yml 的 bashPath 为本机 Git Bash 包装器路径（透明适配，见 component-defs）。',
  },
  'router-standard': {
    label: '路由（router-standard）',
    repo: 'https://github.com/yjh051108/dsh-routing-suite.git',
    // The suite pins its preset submodule (dsh-router-standard); the snapshot
    // is the pinned submodule commit, resolved at fetch time from the suite
    // tree's gitlink — we never chase the submodule's own remote HEAD.
    submodule: {
      repo: 'https://github.com/yjh051108/dsh-router-standard.git',
      path: 'preset',
      files: [
        ['preset/router-standard/agent.cordis.yml', 'agent.cordis.yml'],
        ['preset/router-standard/preset.yml', 'preset.yml'],
        ['preset/router-standard/router-bootstrap-v1.mjs', 'router-bootstrap-v1.mjs'],
        ['preset/router-standard/router-bootstrap.mjs', 'router-bootstrap.mjs'],
        ['preset/router-standard/router-core.mjs', 'router-core.mjs'],
        ['LICENSE', 'LICENSE'],
        ['NOTICE', 'NOTICE'],
      ].map(([src, name]) => ({ src, name })),
    },
    adapter: null,
    manifestNote: '第三方实验预设，逐字搬运（效果与故障归上游）。遵守套件锁定：以 suite 主分支锁定的 preset 子模块为准，不追子模块远端更新。',
  },
  'minimal-gitbash': {
    label: '极简 GitBash（minimal-gitbash）',
    repo: 'https://github.com/liceses/dsh-gitbash-preset.git',
    files: [
      'agent-presets/minimal-gitbash/agent.cordis.yml',
      'agent-presets/minimal-gitbash/gitbash-executor.mjs',
      'agent-presets/minimal-gitbash/preset.yml',
      'LICENSE',
    ].map((p) => ({ src: p, name: p.replace(/^agent-presets\/minimal-gitbash\//, '') })),
    adapter: 'gitbash-shellPath',
    manifestNote: '第三方预设，逐字搬运（效果与故障归上游）。安装时仅替换 agent.cordis.yml 的 shellPath 为本机 Git Bash 路径（透明适配，见 component-defs）。',
  },
}

// Allowlisted repositories for runtime updates — anything outside this list
// is rejected before a fetch starts. Keep in sync with shell-config watch.
const ALLOWED_REPOS = new Set([
  'https://github.com/xiaobright/dsh-anchored-standard.git',
  'https://github.com/yjh051108/dsh-routing-suite.git',
  'https://github.com/yjh051108/dsh-router-standard.git',
  'https://github.com/liceses/dsh-gitbash-preset.git',
])

module.exports = { COMPONENTS, ALLOWED_REPOS }
