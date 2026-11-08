import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const site = 'https://huacnlee.github.io/noop';
const primaryCommand = `curl -fsSL ${site}/install.sh | bash -s -- --primary`;

test('English and Chinese routes keep correct links, language and metadata', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('h1')).toHaveText('Your day can be a no-op.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://huacnlee.github.io/noop/');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/noop/icon.png');
  expect((await page.request.get('/noop/icon.png')).ok()).toBe(true);
  await expect(page.getByRole('link', { name: 'Native Shell' })).toHaveAttribute('href', 'https://nsh.dev');

  await page.locator('#language-toggle').click();
  await page.getByRole('menuitemradio', { name: '简体中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('h1')).toHaveText('你的一天，可以是 no-op');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://huacnlee.github.io/noop/zh-CN/');
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/huacnlee/noop');
  await expect(page.locator('#command-first-0')).toHaveText(primaryCommand);
  expect(errors).toEqual([]);
});

test('published installers are the repository installers', async ({ page }) => {
  for (const file of ['install.sh', 'install.ps1', 'install-client.sh', 'install-client.ps1']) {
    const response = await page.request.get(`/noop/${file}`);
    expect(response.ok()).toBe(true);
    const body = await response.text();
    expect(body).toBe(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
    // GitHub Pages serves .ps1 without a charset, so Windows PowerShell would misread other bytes.
    if (file.endsWith('.ps1')) expect(body).toMatch(/^[\x00-\x7f]*$/);
  }
});

test('screenshot loads at its declared size', async ({ page }) => {
  await page.goto('./');
  const image = page.locator('.app-screenshot img');
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => [element.naturalWidth, element.naturalHeight])).toEqual([2000, 1390]);
});

test('gallery images load and link to full size', async ({ page }) => {
  await page.goto('./');
  const images = page.locator('.gallery img');
  await expect(images).toHaveCount(5);
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2000);
  }
  await expect(page.locator('.gallery a').first()).toHaveAttribute('href', '/noop/screenshot-task.png');
});

test('related projects link to the other projects in both languages', async ({ page }) => {
  for (const [route, name] of [['./', 'More projects'], ['./zh-CN/', '更多项目']]) {
    await page.goto(route);
    const related = page.getByRole('region', { name });
    await expect(related.getByRole('link', { name: 'Disktree' })).toHaveAttribute('href', 'https://huacnlee.github.io/disktree/');
    await expect(related.getByRole('link', { name: 'Omasend' })).toHaveAttribute('href', 'https://huacnlee.github.io/omasend/');
    await expect(related.getByRole('link', { name: 'Omamail' })).toHaveAttribute('href', 'https://huacnlee.github.io/omamail/');
    await expect(related.getByRole('link', { name: 'huacnlee/cargo' })).toHaveAttribute('href', 'https://huacnlee.github.io/cargo/');
    await expect(related.getByRole('link', { name: 'omarchy-mihoro' })).toHaveAttribute('href', 'https://github.com/huacnlee/omarchy-mihoro');
    await expect(related.getByRole('link', { name: 'omarchy-which-key' })).toHaveAttribute('href', 'https://github.com/huacnlee/omarchy-which-key');
    await expect(related.locator('li p')).toHaveCount(6);
  }
});

test('light and dark toggle follows system then persists across reload and language navigation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'false');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#language-toggle').click();
  await page.getByRole('menuitemradio', { name: '简体中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('language menu handles keyboard selection, escape and outside click', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Language' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeFocused();
  await expect(page.getByRole('menuitemradio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitemradio', { name: '简体中文' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Language' })).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByRole('button', { name: 'Language' }).click();
  await page.locator('h1').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('tabs switch with mouse and keyboard and copy the chosen command', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  const first = page.getByRole('tab', { name: 'First machine', exact: true });
  const client = page.getByRole('tab', { name: 'Client app', exact: true });
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'More machines', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'panel-more');
  await page.locator('[data-copy="command-more-1"]').click();
  await expect(page.getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`irm ${site}/install.ps1 | iex`);
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'More machines', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(client).toBeFocused();
  await expect(page.getByRole('tabpanel').getByRole('link', { name: /Android/ })).toHaveAttribute('href', 'https://github.com/huacnlee/noop/releases/latest/download/noop-android.apk');
  await expect(page.getByRole('tabpanel').getByRole('link', { name: /iOS/ })).toHaveAttribute('href', 'https://github.com/huacnlee/noop/releases/latest/download/noop-ios-unsigned.ipa');
  await page.locator('[data-copy="command-client-0"]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`curl -fsSL ${site}/install-client.sh | bash`);
  await page.keyboard.press('Tab');
  await client.focus();
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await page.locator('[data-copy="command-first-0"]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(primaryCommand);
});

for (const [width, height] of [[360, 640], [1440, 900]]) {
  test(`installation follows hero in first viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const route of ['./', './zh-CN/']) {
      await page.goto(route);
      expect(await page.locator('.hero').evaluate(element => element.nextElementSibling?.id)).toBe('install');
      const bounds = await page.locator('#command-first-0').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    }
  });
}

for (const width of [360, 768, 1440]) {
  test(`layout fits ${width}px and reduced motion retains content`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const route of ['./', './zh-CN/']) {
      await page.goto(route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.locator('h1')).toBeVisible();
      if (width > 680) await expect(page.locator('.decision-replied')).toHaveCSS('opacity', '1');
    }
  });
}

test('keyboard reaches skip link and section link', async ({ page }) => {
  await page.goto('./');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'See how it works' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#workflow$/);
});

test('Chinese headings have no trailing full stop', async ({ page }) => {
  await page.goto('./zh-CN/');
  for (const text of await page.locator('h1, h2, h3, .eyebrow').allTextContents()) {
    expect(text.trim()).not.toMatch(/。/);
  }
});

test('every page asks for sponsorship with a visible button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [route, text, nav, button] of [['./', 'If this helps you, please sponsor me.', 'Sponsor me', 'Sponsor on GitHub'], ['./zh-CN/', '如果这个项目帮到了你，请赞助我。', '赞助作者', '在 GitHub 上赞助']]) {
    await page.goto(route);
    await expect(page.locator('.sponsor p')).toHaveText(text);
    await expect(page.locator('.sponsor .sponsor-button')).toHaveText(button);
    await expect(page.locator('nav .sponsor-button')).toHaveText(nav);
    await expect(page.locator('nav .sponsor-button')).toBeVisible();
    for (const link of await page.locator('.sponsor-button').all()) {
      await expect(link).toHaveAttribute('href', 'https://github.com/sponsors/huacnlee');
      await expect(link).toHaveAttribute('target', '_blank');
    }
  }
});

test('the sponsor card follows install and stays on phones', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('./');
  await expect(page.locator('#install + .sponsor')).toBeVisible();
  await expect(page.locator('nav .sponsor-button')).toBeHidden();
});
