import { expect, test } from '@playwright/test';

test('核心计划工作流和移动只读视图', async ({ page }) => {
  const username = `user_${Date.now()}`;
  await page.goto('/register');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill('password123');
  await page.getByLabel('确认密码').fill('password123');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByRole('heading', { name: '全部计划' })).toBeVisible();

  await page.getByRole('button', { name: '新建领域' }).first().click();
  await page.getByLabel('领域名称').fill('工作');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: /工作/ }).first()).toBeVisible();

  await page.getByRole('button', { name: '新建计划' }).first().click();
  await page.getByLabel('计划名称').fill('实习准备');
  await page.getByLabel('说明').fill('准备学习、项目与投递路径');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByRole('button', { name: /实习准备/ }).click();
  await expect(page.getByRole('heading', { name: '实习准备' })).toBeVisible();

  await page.getByRole('button', { name: '添加节点' }).click();
  await page.getByRole('button', { name: '添加节点' }).click();
  await expect(page.locator('.graph-node')).toHaveCount(2);
  await page.waitForTimeout(700);
  const source = page.locator('.graph-node').first().locator('.react-flow__handle.source');
  const target = page.locator('.graph-node').nth(1).locator('.react-flow__handle.target');
  const sourceBox = await source.boundingBox(); const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('节点连接点不可见');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.locator('.graph-node').first().click();
  await page.getByLabel('名称').fill('学习推理基础');
  await page.getByLabel('简短说明').fill('完成基础知识梳理');
  await expect(page.getByText('已保存')).toBeVisible();
  await page.getByRole('button', { name: '编辑附加信息' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('# 学习记录\n\n完成第一轮梳理。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('附加信息已保存')).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).first().click();
  await page.waitForTimeout(2800);
  await page.screenshot({ path: 'test-results/desktop-graph.png', fullPage: true });

  await page.getByTitle('返回计划总览').click();
  await page.getByLabel('计划操作').click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await page.getByRole('button', { name: '确认归档' }).click();
  await page.getByRole('button', { name: /已归档/ }).click();
  await expect(page.getByText('归档计划保持只读，可随时恢复或导出。')).toBeVisible();
  await page.getByRole('button', { name: /实习准备/ }).click();
  await expect(page.getByText('归档计划为只读状态。恢复后才能继续编辑。')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加节点' })).toHaveCount(0);
  await page.getByTitle('返回计划总览').click();
  await page.getByLabel('计划操作').click();
  await page.getByRole('menuitem', { name: '恢复' }).click();
  await expect(page.getByText('计划已恢复')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /工作/ }).first().click();
  await page.getByRole('button', { name: /实习准备/ }).click();
  await expect(page.getByText('移动端只读')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加节点' })).toHaveCount(0);
  await expect(page.locator('.graph-node').first()).toBeVisible();
  await page.waitForTimeout(2800);
  await page.screenshot({ path: 'test-results/mobile-graph.png', fullPage: true });
});
