import { expect, test } from '@playwright/test'

test('preview serves CSP and cross-origin isolation headers', async ({ page }) => {
  const response = await page.goto('/')
  expect(response, 'document response').not.toBeNull()
  const headers = response!.headers()

  const csp = headers['content-security-policy'] ?? ''
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).not.toContain('unsafe-eval')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp')
  expect(headers['x-content-type-options']).toBe('nosniff')

  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function')
})

test('the workspace loads without CSP violations', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text())
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Fill a part with a printable lattice' })).toBeVisible()
  expect(violations).toEqual([])
})
