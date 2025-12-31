import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('dashboard loads with correct elements', async ({ page }) => {
    await page.goto('/');

    // Check page title
    await expect(page).toHaveTitle(/AAC Marketing Hub/);

    // Check dashboard heading
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // Check nav is present
    await expect(page.getByText('AAC Hub')).toBeVisible();

    // Check quick stats cards are present
    await expect(page.getByText('Active Campaigns')).toBeVisible();
    await expect(page.getByText('Messages Sent (24h)')).toBeVisible();
    await expect(page.getByText('Response Rate')).toBeVisible();

    // Check system status section
    await expect(page.getByText('System Status')).toBeVisible();
  });

  test('can navigate to all main pages', async ({ page }) => {
    await page.goto('/');

    // Navigate to Campaigns
    await page.getByRole('link', { name: 'Campaigns' }).click();
    await expect(page).toHaveURL('/campaigns');
    await expect(page.getByRole('heading', { name: 'SMS Campaigns' })).toBeVisible();

    // Navigate to Health
    await page.getByRole('link', { name: 'Health' }).click();
    await expect(page).toHaveURL('/health');
    await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();

    // Navigate to Calendar
    await page.getByRole('link', { name: 'Calendar' }).click();
    await expect(page).toHaveURL('/calendar');
    await expect(page.getByRole('heading', { name: 'Content Calendar' })).toBeVisible();

    // Navigate to Content
    await page.getByRole('link', { name: 'Content' }).click();
    await expect(page).toHaveURL('/content');
    await expect(page.getByRole('heading', { name: 'Content Library' })).toBeVisible();

    // Navigate to Ads
    await page.getByRole('link', { name: 'Ads' }).click();
    await expect(page).toHaveURL('/ads');
    await expect(page.getByRole('heading', { name: 'Ad Generation' })).toBeVisible();

    // Navigate to Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Navigate back to Dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('settings page shows connected accounts', async ({ page }) => {
    await page.goto('/settings');

    // Check connected services are listed
    await expect(page.getByText('Connected Accounts')).toBeVisible();
    await expect(page.getByText('Pipedrive')).toBeVisible();
    await expect(page.getByText('Quo (OpenPhone)')).toBeVisible();
    await expect(page.getByText('QuickBooks')).toBeVisible();
  });

  test('health page shows all metrics sections', async ({ page }) => {
    await page.goto('/health');

    await expect(page.getByText('Webhook Processing (24h)')).toBeVisible();
    await expect(page.getByText('Sync Coverage')).toBeVisible();
    await expect(page.getByText('Recent Errors')).toBeVisible();
    await expect(page.getByText('QStash Queue')).toBeVisible();
  });

  test('campaigns page shows CLI instructions', async ({ page }) => {
    await page.goto('/campaigns');

    await expect(page.getByText('New Campaign')).toBeVisible();
    await expect(page.getByText('npm run campaign:start')).toBeVisible();
  });
});
