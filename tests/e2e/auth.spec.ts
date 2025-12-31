import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  // This test runs without the stored auth state
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
  });

  test('login page shows correct elements', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'AAC Marketing Hub' })).toBeVisible();
    await expect(page.getByText('Enter password to continue')).toBeVisible();
    await expect(page.getByPlaceholder('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('shows error for invalid password', async ({ page }) => {
    await page.goto('/login');

    await page.getByPlaceholder('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Invalid password')).toBeVisible();
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    const password = process.env.AUTH_PASSWORD;
    if (!password) {
      test.skip();
      return;
    }

    await page.goto('/login');

    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
