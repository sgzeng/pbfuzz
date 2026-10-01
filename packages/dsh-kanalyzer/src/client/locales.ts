/** Copy for the kanalyzer settings card. */

/** Dictionary namespace owned by this card. */
export const LOCALE_NS = 'settings.kanalyzer'

/** Every key the card renders. */
export type KanalyzerLocaleKey =
  | 'title' | 'description' | 'expand' | 'collapse' | 'pbfuzzNote'
  | 'tagInstalled' | 'tagNotBuilt' | 'unsaved' | 'readOnly'
  | 'save' | 'saving' | 'discard' | 'saveFailed' | 'overridden' | 'reset' | 'invalid'
  | 'groupInstall' | 'groupInstallHint' | 'groupDefaults' | 'groupDefaultsHint' | 'groupDumps' | 'groupDumpsHint'
  | 'groupStandalone' | 'groupStandaloneHint' | 'groupStatus' | 'groupStatusHint'
  | 'install.installDir' | 'install.installDir.hint'
  | 'install.repoUrl' | 'install.repoUrl.hint'
  | 'install.branch' | 'install.branch.hint'
  | 'install.llvmPrefix' | 'install.llvmPrefix.hint' | 'install.llvmPrefix.placeholder'
  | 'install.buildType' | 'install.buildType.hint'
  | 'install.jobs' | 'install.jobs.hint'
  | 'defaults.verbose' | 'defaults.verbose.hint'
  | 'defaults.callStackLen' | 'defaults.callStackLen.hint'
  | 'defaults.useTypeBasedCallGraph' | 'defaults.useTypeBasedCallGraph.hint'
  | 'defaults.dumps.policy' | 'defaults.dumps.distance' | 'defaults.dumps.criticalBranch'
  | 'defaults.dumps.bidMappingAndFuncInfo' | 'defaults.dumps.callerCalleeBothWays' | 'defaults.dumps.annotatedIr'
  | 'defaults.timeoutSec' | 'defaults.timeoutSec.hint'
  | 'defaults.memLimitMB' | 'defaults.memLimitMB.hint'
  | 'defaults.cacheEnabled' | 'defaults.cacheEnabled.hint'
  | 'standalone.inputFilenames' | 'standalone.inputFilenames.hint'
  | 'standalone.targetList' | 'standalone.targetList.hint'
  | 'standalone.entryList' | 'standalone.entryList.hint'
  | 'listAdd' | 'listRemove' | 'listEmpty' | 'choose'
  | 'statusInstalled' | 'statusBinary' | 'statusCommit' | 'statusLlvm' | 'statusDoctor' | 'statusDoctorAt'
  | 'statusYes' | 'statusNo' | 'statusNone' | 'doctorPass' | 'doctorFail' | 'doctorNever'
  | 'statusWllvm' | 'wllvmPass' | 'wllvmFail' | 'wllvmNever'
  | 'binaryMissing'
  | 'build' | 'rebuild' | 'buildHint' | 'selfTest' | 'selfTestHint' | 'refresh' | 'refreshing' | 'refreshFailed'
  | 'installWllvm' | 'installWllvmHint'
  | 'openSession' | 'cwdFallback'
  | 'actCreating' | 'actDispatching' | 'actBuildRunning' | 'actBuildDone'
  | 'actWaitingDoctor' | 'actDoctorPass' | 'actDoctorFail' | 'actDoctorNoStatus'
  | 'actCreateFailed' | 'actCommandMissing' | 'actRefused' | 'actHandlerError' | 'actBinaryNotFound'
  | 'actInstallingDeps' | 'actInstallDepsPass' | 'actInstallDepsFail'

/** English copy. */
export const en: Record<KanalyzerLocaleKey, string> = {
  title: 'kanalyzer (KAMain static analysis)',
  description: 'LLVM call-graph and reachability analysis. Build it once; callers pass their own inputs.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  pbfuzzNote: 'If pbfuzz drives kanalyzer, you only need to press Build once. The defaults work, and pbfuzz passes the bitcode, targets, entries and dumps for each run itself.',
  tagInstalled: 'Installed',
  tagNotBuilt: 'Not built',
  unsaved: 'Unsaved',
  readOnly: 'This deployment stores settings read-only.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The deployment did not accept these values. Your edits are still here so you can fix them.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalid: 'Not a valid value for this field.',
  groupInstall: 'Install / build',
  groupInstallHint: 'KAMain is not bundled. Build clones and compiles it with a visible agent session.',
  groupDefaults: 'Default analysis options',
  groupDefaultsHint: 'Used by standalone /kanalyzer analyze. A caller that passes its own options overrides these.',
  groupDumps: 'Dumps',
  groupDumpsHint: 'Paired dumps are written only when both halves of the pair are requested.',
  groupStandalone: 'Standalone run inputs (manual use only)',
  groupStandaloneHint: 'Only used when you run /kanalyzer analyze by hand. When pbfuzz drives kanalyzer these are ignored, because pbfuzz passes the inputs from the campaign. Leave them empty unless you run it manually.',
  groupStatus: 'Status',
  groupStatusHint: 'Written by the plugin after a build or self-test. Press Refresh to re-read it.',
  'install.installDir': 'Install directory',
  'install.installDir.hint': 'The clone goes to <install directory>/kernel-analyzer.',
  'install.repoUrl': 'Repository URL',
  'install.repoUrl.hint': 'Git repository of kernel-analyzer.',
  'install.branch': 'Branch',
  'install.branch.hint': 'Branch to check out.',
  'install.llvmPrefix': 'LLVM prefix',
  'install.llvmPrefix.hint': 'Leave empty to auto-detect. KAMain needs LLVM 10–16 and 14 is the verified version, so auto-detection prefers /usr/lib/llvm-14.',
  'install.llvmPrefix.placeholder': 'auto-detect (prefers /usr/lib/llvm-14)',
  'install.buildType': 'Build type',
  'install.buildType.hint': 'CMake build type.',
  'install.jobs': 'Parallel build jobs',
  'install.jobs.hint': '0 means one job per CPU (nproc).',
  'defaults.verbose': 'Verbosity',
  'defaults.verbose.hint': 'Keep at 1 or higher. KAMain exits 0 whether or not it found the target, so its verbose output is the only way to tell success from a silent no-op.',
  'defaults.callStackLen': 'Call stack length',
  'defaults.callStackLen.hint': 'Maximum call depth explored.',
  'defaults.useTypeBasedCallGraph': 'Type-based call graph',
  'defaults.useTypeBasedCallGraph.hint': 'On: signature-based call graph (what the Magma pipeline used). Off: TyPM/MLTA, which is more precise and much slower.',
  'defaults.dumps.policy': 'Policy',
  'defaults.dumps.distance': 'Distance',
  'defaults.dumps.criticalBranch': 'Critical branches',
  'defaults.dumps.bidMappingAndFuncInfo': 'BB-id mapping + function info (pair)',
  'defaults.dumps.callerCalleeBothWays': 'Caller→callee + callee→caller (pair)',
  'defaults.dumps.annotatedIr': 'Annotated IR',
  'defaults.timeoutSec': 'Timeout (s)',
  'defaults.timeoutSec.hint': 'Large projects are slow; each analysis runs as a job with this timeout.',
  'defaults.memLimitMB': 'Memory limit (MB)',
  'defaults.memLimitMB.hint': 'At least 256.',
  'defaults.cacheEnabled': 'Cache results',
  'defaults.cacheEnabled.hint': 'Reuse results keyed on bitcode, KAMain commit and options.',
  'standalone.inputFilenames': 'Input bitcode files',
  'standalone.inputFilenames.hint': 'Paths to *.bc files.',
  'standalone.targetList': 'Targets',
  'standalone.targetList.hint': 'file:line. The line must contain an instruction (not a comment or a declaration).',
  'standalone.entryList': 'Entry functions',
  'standalone.entryList.hint': 'For example LLVMFuzzerTestOneInput or main.',
  listAdd: 'Add',
  listRemove: 'Remove',
  listEmpty: 'None',
  choose: 'Choose',
  statusInstalled: 'Installed',
  statusBinary: 'Binary',
  statusCommit: 'Commit',
  statusLlvm: 'LLVM',
  statusDoctor: 'Last self-test',
  statusDoctorAt: 'at',
  statusYes: 'Yes',
  statusNo: 'No',
  statusNone: '—',
  doctorPass: 'Passed',
  doctorFail: 'Failed',
  doctorNever: 'Never run',
  statusWllvm: 'wllvm',
  wllvmPass: 'Installed',
  wllvmFail: 'Failed',
  wllvmNever: 'Never run',
  binaryMissing: 'The kanalyzer (KAMain) binary hasn’t been built yet. Press Build.',
  build: 'Build',
  rebuild: 'Rebuild',
  buildHint: 'Opens a visible session that clones, installs dependencies and builds KAMain. You can watch it and approve steps such as sudo apt.',
  selfTest: 'Self-test',
  selfTestHint: 'Runs /kanalyzer doctor: a real analysis of the bundled sample.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  refreshFailed: 'Could not re-read the status from the deployment.',
  installWllvm: 'Install wllvm',
  installWllvmHint: 'Opens a visible session that runs pip install --user wllvm, then reruns the self-test.',
  openSession: 'Open session',
  cwdFallback: 'The install directory can’t be used as a working directory yet, so the session started in the default directory. The build agent will create the install directory.',
  actCreating: 'Creating session…',
  actDispatching: 'Sending command…',
  actBuildRunning: 'Build running in its session. This card updates when the plugin reports the binary; press Refresh to check.',
  actBuildDone: 'Build finished: binary installed.',
  actWaitingDoctor: 'Waiting for the self-test result…',
  actDoctorPass: 'Self-test passed.',
  actDoctorFail: 'Self-test failed.',
  actDoctorNoStatus: 'The command finished, but the plugin didn’t record a result. Its reply:',
  actCreateFailed: 'Could not create a session.',
  actCommandMissing: 'The /kanalyzer command isn’t available. Is the dsh-kanalyzer host plugin loaded?',
  actRefused: 'The deployment refused the command.',
  actHandlerError: 'The command reported an error.',
  actBinaryNotFound: 'The kanalyzer (KAMain) binary hasn’t been built yet. Press Build first.',
  actInstallingDeps: 'Installing wllvm and rerunning the self-test…',
  actInstallDepsPass: 'wllvm installed; self-test passed.',
  actInstallDepsFail: 'wllvm install finished, but the self-test still fails.',
}

/** Chinese copy. */
export const zh: Record<KanalyzerLocaleKey, string> = {
  ...en,
  title: 'kanalyzer（KAMain 静态分析）',
  description: 'LLVM 调用图与可达性分析。只需构建一次；调用方自带输入。',
  expand: '展开设置',
  collapse: '收起设置',
  pbfuzzNote: '由 pbfuzz 驱动时，只需点一次“构建”：默认值即可用，每次运行的 bitcode、目标、入口和 dump 都由 pbfuzz 自己传入。',
  tagInstalled: '已安装',
  tagNotBuilt: '未构建',
  unsaved: '未保存',
  readOnly: '此部署的设置为只读。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '部署未接受这些值；已保留你的修改以便更正。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '该字段不接受此值。',
  groupInstall: '安装 / 构建',
  groupDefaults: '默认分析选项',
  groupDumps: '输出（dump）',
  groupStandalone: '独立运行输入（仅手动使用）',
  groupStandaloneHint: '仅在手动运行 /kanalyzer analyze 时使用。由 pbfuzz 驱动时忽略这些值（pbfuzz 从 campaign 传入）。除非手动运行，否则留空。',
  groupStatus: '状态',
  groupStatusHint: '由插件在构建或自检后写入。点“刷新”重新读取。',
  build: '构建',
  rebuild: '重新构建',
  selfTest: '自检',
  refresh: '刷新',
  refreshing: '刷新中…',
  openSession: '打开会话',
  binaryMissing: 'kanalyzer（KAMain）尚未构建。请点“构建”。',
  statusWllvm: 'wllvm',
  wllvmPass: '已安装',
  wllvmFail: '失败',
  wllvmNever: '从未运行',
  installWllvm: '安装 wllvm',
  installWllvmHint: '打开一个可见会话，执行 pip install --user wllvm，然后重新运行自检。',
  actCreating: '正在创建会话…',
  actDispatching: '正在发送命令…',
  actBuildRunning: '构建正在其会话中运行。插件报告二进制后本卡片会更新；可点“刷新”。',
  actBuildDone: '构建完成：已安装。',
  actWaitingDoctor: '正在等待自检结果…',
  actDoctorPass: '自检通过。',
  actDoctorFail: '自检失败。',
  actCreateFailed: '无法创建会话。',
  actCommandMissing: '/kanalyzer 命令不可用——dsh-kanalyzer 宿主插件是否已加载？',
  actRefused: '部署拒绝了该命令。',
  actHandlerError: '命令报告了错误。',
  actBinaryNotFound: 'kanalyzer（KAMain）尚未构建。请先点“构建”。',
  actInstallingDeps: '正在安装 wllvm 并重新运行自检…',
  actInstallDepsPass: 'wllvm 已安装；自检通过。',
  actInstallDepsFail: 'wllvm 安装已完成，但自检仍未通过。',
}
