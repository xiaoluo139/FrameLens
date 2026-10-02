/**
 * 某些受限环境（无 passwd 条目 / 沙箱）里 os.userInfo() 会抛 ENOMEM，
 * 导致 Capacitor CLI 直接崩溃。这里兜一个安全的返回值。
 * 用法：node --require ./tools/userinfo-shim.cjs <cli>
 */

const os = require('node:os');
const original = os.userInfo;

os.userInfo = (...args) => {
  try {
    return original(...args);
  } catch {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return { username: 'user', uid: -1, gid: -1, shell: null, homedir: home };
  }
};
