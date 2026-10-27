// Shell strings (tray, dialogs, toasts, window titles). The window content is
// the Web client, which owns the language choice: it reports the resolved
// language over IPC ('kraki:language') and we persist it so the tray is right
// before the page loads next time. Adding a language = one more dictionary
// with the same keys (test/i18n.test.cjs checks keys and placeholders).

const en = {
  'dialog.locateTitle': 'Locate kraki manually',
  'dialog.executable': 'Kraki executable',
  'error.builtInManagesPC': 'The built-in Kraki manages this PC.',
  'error.selectExecutable': 'Select an existing kraki executable.',
  'error.cliVersion': 'The selected CLI did not report a Kraki version.',
  'error.builtInMissing': 'The built-in Kraki is missing from this installation.',
  'error.startFailed': 'Kraki did not start. See the logs in {path}',
  'error.startupApps': 'Windows could not add Kraki to Startup apps. Open Settings → Apps → Startup, then try again.',
  'window.signIn': 'Sign in with GitHub',
  'window.logs': 'Kraki Logs',
  'logs.empty': 'No logs yet. Path: {path}',
  'menu.openLink': 'Open Link in Browser',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'tray.unread': '{count} unread',
  'tray.needsYou': 'Needs You',
  'tray.more': '{count} more…',
  'tray.open': 'Open Kraki',
  'tray.usage': 'Account Usage',
  'tray.goOffline': 'Take This PC Offline',
  'tray.goOnline': 'Bring This PC Online',
  'tray.settings': 'Settings…',
  'tray.quitOffline': 'Quit Kraki and Go Offline…',
  'tray.quit': 'Quit Kraki',
  'status.checking': 'Checking this PC…',
  'status.online': 'This PC is online',
  'status.goingOnline': 'This PC is going online…',
  'status.goingOffline': 'This PC is going offline…',
  'status.offline': 'This PC is offline',
  'status.cli': 'This PC is online (command-line Kraki)',
  'status.controlsOthersOnly': 'This PC controls other computers',
  'detail.online': 'Your phone and other computers can use its agents',
  'detail.offline': "Your phone can't use the agents on this PC",
  'detail.cli': 'Managed by the command-line Kraki',
  'detail.controlsOthersOnly': 'No agents run on this PC',
  'quit.message': 'Quit Kraki and take this PC offline?',
  'quit.detail': "Your phone and other computers won't be able to use the agents on this PC until you open Kraki again.\n\nTo keep this PC online, just close the window. Kraki stays in the tray.",
  'quit.confirm': 'Quit and Go Offline',
  'quit.cancel': 'Cancel',
  'quit.dontAsk': "Don't ask again",
  'stillOnline.title': 'Kraki is still online',
  'stillOnline.body': 'Your phone can keep using this PC. Open Kraki from the tray any time; quit it there to take this PC offline.',
  'error.shortcutInUse': 'This shortcut is already in use or is not supported.',
  'error.shortcutUnsafe': 'Use a function key or a shortcut with Control or Alt.',
  'error.loginItem': 'Windows could not change the login item.',
  'error.selectionCancelled': 'Selection cancelled.',
  'error.setupFirst': 'Set up Kraki on this PC first.',
  'error.updatePolicy': 'Kraki could not change its update policy.',
  'error.external.start': "Couldn't start the command-line Kraki.",
  'error.external.stop': "Couldn't stop the command-line Kraki.",
  'error.external.restart': "Couldn't restart the command-line Kraki.",
};

const zhHans = {
  'dialog.locateTitle': '定位 kraki 可执行文件',
  'dialog.executable': 'Kraki 可执行文件',
  'error.builtInManagesPC': '内置 Kraki 正在管理这台电脑。',
  'error.selectExecutable': '请选择现有的 kraki 可执行文件。',
  'error.cliVersion': '所选 CLI 未报告 Kraki 版本。',
  'error.builtInMissing': '此安装中缺少内置 Kraki。',
  'error.startFailed': 'Kraki 未能启动。请查看 {path} 中的日志。',
  'error.startupApps': 'Windows 无法将 Kraki 添加到启动应用。请打开“设置 → 应用 → 启动”，然后重试。',
  'window.signIn': '使用 GitHub 登录',
  'window.logs': 'Kraki 日志',
  'logs.empty': '暂无日志。路径：{path}',
  'menu.openLink': '在浏览器中打开链接',
  'menu.cut': '剪切',
  'menu.copy': '复制',
  'menu.paste': '粘贴',
  'menu.selectAll': '全选',
  'tray.unread': '{count} 条未读',
  'tray.needsYou': '需要你处理',
  'tray.more': '还有 {count} 个…',
  'tray.open': '打开 Kraki',
  'tray.usage': '账户用量',
  'tray.goOffline': '让这台电脑离线',
  'tray.goOnline': '让这台电脑上线',
  'tray.settings': '设置…',
  'tray.quitOffline': '退出 Kraki 并离线…',
  'tray.quit': '退出 Kraki',
  'status.checking': '正在检查这台电脑…',
  'status.online': '这台电脑已上线',
  'status.goingOnline': '这台电脑正在上线…',
  'status.goingOffline': '这台电脑正在离线…',
  'status.offline': '这台电脑已离线',
  'status.cli': '这台电脑已上线（命令行版 Kraki）',
  'status.controlsOthersOnly': '这台电脑用于控制其他电脑',
  'detail.online': '你的手机和其他电脑可以使用它上面的 Agent',
  'detail.offline': '你的手机无法使用这台电脑上的 Agent',
  'detail.cli': '由命令行版 Kraki 管理',
  'detail.controlsOthersOnly': '这台电脑上没有运行 Agent',
  'quit.message': '退出 Kraki 并让这台电脑离线？',
  'quit.detail': '在你重新打开 Kraki 之前，手机和其他电脑都无法使用这台电脑上的 Agent。\n\n如果想保持在线，只需关闭窗口，Kraki 会留在托盘中。',
  'quit.confirm': '退出并离线',
  'quit.cancel': '取消',
  'quit.dontAsk': '不再询问',
  'stillOnline.title': 'Kraki 仍在线',
  'stillOnline.body': '你的手机仍可使用这台电脑。随时可以从托盘打开 Kraki；在托盘中退出即可让这台电脑离线。',
  'error.shortcutInUse': '此快捷键已被占用或不受支持。',
  'error.shortcutUnsafe': '请使用功能键，或包含 Ctrl 或 Alt 的组合键。',
  'error.loginItem': 'Windows 无法更改开机启动项。',
  'error.selectionCancelled': '已取消选择。',
  'error.setupFirst': '请先在这台电脑上设置 Kraki。',
  'error.updatePolicy': 'Kraki 无法更改更新策略。',
  'error.external.start': '无法启动命令行版 Kraki。',
  'error.external.stop': '无法停止命令行版 Kraki。',
  'error.external.restart': '无法重启命令行版 Kraki。',
};

const DICTIONARIES = { en, 'zh-Hans': zhHans };
let current = 'en';

/** Same rules as the Web client's matchLanguageTag (Traditional ≠ zh-Hans). */
function matchLanguage(tag) {
  const lower = String(tag || '').toLowerCase();
  const [lang, ...rest] = lower.split(/[-_]/);
  if (lang === 'zh') return rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? null : 'zh-Hans';
  return lang === 'en' ? 'en' : null;
}
function resolveLanguage(tags) {
  for (const tag of tags || []) { const m = matchLanguage(tag); if (m) return m; }
  return 'en';
}
const isLanguage = (code) => typeof code === 'string' && Object.hasOwn(DICTIONARIES, code);
function setLanguage(code) {
  if (!Object.hasOwn(DICTIONARIES, code) || code === current) return false;
  current = code;
  return true;
}
const language = () => current;
function t(key, vars) {
  const text = DICTIONARIES[current][key] ?? en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

module.exports = { t, setLanguage, isLanguage, language, resolveLanguage, matchLanguage, DICTIONARIES };
