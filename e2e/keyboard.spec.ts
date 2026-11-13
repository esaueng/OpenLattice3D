import { expect, test, type Locator } from '@playwright/test'
import { goToStep, loadSampleSphere, openWorkspace, sidePanel } from './helpers'

async function checkedName(group: Locator): Promise<string> {
  const checked = group.getByRole('radio', { checked: true })
  await expect(checked).toHaveCount(1)
  return (await checked.textContent())?.trim() ?? ''
}

test('lattice picker is one tab stop and arrow keys move the selection', async ({ page }) => {
  await openWorkspace(page)
  await loadSampleSphere(page)
  await goToStep(page, 'Lattice')

  const group = sidePanel(page).getByRole('radiogroup', { name: 'Lattice type' })
  const radios = group.getByRole('radio')
  await expect(radios).toHaveCount(12)

  // Exactly one option is in the tab order, and it is the checked one.
  const tabStops = group.locator('[role="radio"][tabindex="0"]')
  await expect(tabStops).toHaveCount(1)
  await expect(tabStops).toHaveAttribute('aria-checked', 'true')

  const first = group.getByRole('radio').first()
  const second = group.getByRole('radio').nth(1)
  const last = group.getByRole('radio').last()

  await group.getByRole('radio', { checked: true }).focus()
  await page.keyboard.press('Home')
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('aria-checked', 'true')

  await page.keyboard.press('ArrowRight')
  await expect(second).toBeFocused()
  await expect(second).toHaveAttribute('aria-checked', 'true')
  await expect(first).toHaveAttribute('aria-checked', 'false')
  await expect(second).toHaveAttribute('tabindex', '0')
  await expect(first).toHaveAttribute('tabindex', '-1')

  await page.keyboard.press('ArrowDown')
  await expect(group.getByRole('radio').nth(2)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowLeft')
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('aria-checked', 'true')

  // Left from the first option wraps to the last.
  await page.keyboard.press('ArrowLeft')
  await expect(last).toBeFocused()
  await expect(last).toHaveAttribute('aria-checked', 'true')
  const selected = await checkedName(group)

  // Tab leaves the group in one step; Shift+Tab comes back to the checked option.
  await page.keyboard.press('Tab')
  expect(await group.evaluate((el) => el.contains(document.activeElement))).toBe(false)
  await page.keyboard.press('Shift+Tab')
  await expect(last).toBeFocused()
  expect(await checkedName(group)).toBe(selected)
  await expect(tabStops).toHaveCount(1)
})
