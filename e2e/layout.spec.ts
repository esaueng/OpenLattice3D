import { expect, test } from '@playwright/test'
import { forEachWorkflowStage } from './helpers'

// Tagged @mobile so it runs in both projects: desktop 1440×900 and iPhone 13.
test('no horizontal page scroll on any workflow step @mobile', async ({ page }) => {
  const overflow: string[] = []
  await forEachWorkflowStage(page, async (stage) => {
    const metrics = await page.evaluate(() => {
      const root = document.documentElement
      window.scrollTo({ left: 10_000, behavior: 'instant' })
      const scrolledX = window.scrollX
      window.scrollTo({ left: 0, behavior: 'instant' })
      return {
        viewport: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        scrolledX,
      }
    })
    if (metrics.scrolledX > 0 || metrics.rootScrollWidth > metrics.viewport || metrics.bodyScrollWidth > metrics.viewport) {
      overflow.push(`${stage}: ${JSON.stringify(metrics)}`)
    }
  })
  expect(overflow, 'steps with horizontal page scroll').toEqual([])
})
