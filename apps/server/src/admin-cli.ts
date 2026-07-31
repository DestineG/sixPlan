import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildApp } from './app.js';
import { createUser } from './auth.js';
import { normalizeUsername } from './security.js';

const [command, usernameArg] = process.argv.slice(2);
if (!command || !usernameArg || !['create', 'promote'].includes(command)) {
  console.error('用法：npm run admin -- create <username> 或 npm run admin -- promote <username>');
  process.exit(1);
}

const app = await buildApp();
try {
  if (command === 'promote') {
    const result = app.database.sqlite.prepare(`UPDATE users SET role='admin', version=version+1, updated_at=? WHERE username_normalized=?`)
      .run(new Date().toISOString(), normalizeUsername(usernameArg));
    if (result.changes === 0) throw new Error('用户不存在');
    console.log(`已将 ${usernameArg} 提升为管理员`);
  } else {
    const terminal = createInterface({ input, output });
    const password = process.env.SIXPLAN_ADMIN_PASSWORD ?? await terminal.question('管理员初始密码（输入可见，也可使用 SIXPLAN_ADMIN_PASSWORD）：');
    terminal.close();
    await createUser(app, usernameArg, password, 'admin');
    console.log(`管理员 ${usernameArg} 已创建`);
  }
} finally {
  await app.close();
}
