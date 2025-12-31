import { test as setup, expect } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, '../.auth/user.json');

setup('authenticate', async ({ page }) => {
  const password = process.env.AUTH_PASSWORD;
  if (!password) {
    throw new Error('AUTH_PASSWORD environment variable is required for E2E tests');
  }

  // Go to login page
  await page.goto('/login');

  // Fill in password and submit
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for redirect to dashboard
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Save authentication state
  await page.context().storageState({ path: authFile });
});
