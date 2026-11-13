import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { forEachWorkflowStage } from './helpers'

const BLOCKING_IMPACTS = new Set(['serious', 'critical'])

/**
 * Known findings awaiting a fix in src/, matched by rule AND exact node target
 * so the rule still fails anywhere else. Remove an entry once it is fixed.
 *
 * label-content-name-mismatch (WCAG 2.5.3): the step footer buttons in
 * src/components/PanelChrome.tsx (`StepPanel`) render visible text "Back" +
 * <kbd>B</kbd> and "Continue to regions" + <kbd>N</kbd>, but their aria-label
 * ("Back to Model. Shortcut B", "Continue to Regions. Shortcut N") does not
 * contain that visible text.
 */
const KNOWN_ISSUES: readonly { rule: string; target: string }[] = [
  { rule: 'label-content-name-mismatch', target: '.workflow-nav-back' },
  { rule: 'label-content-name-mismatch', target: '.workflow-nav-next' },
]

function isKnownIssue(rule: string, target: string): boolean {
  return KNOWN_ISSUES.some((known) => known.rule === rule && known.target === target)
}

test('no serious or critical axe violations on any workflow step', async ({ page }) => {
  const blocking: string[] = []
  const reported: string[] = []
  await forEachWorkflowStage(page, async (stage) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    for (const violation of results.violations) {
      for (const node of violation.nodes) {
        const target = node.target.join(' ')
        const line = `[${stage}] ${violation.impact} ${violation.id} (${violation.help}): ${target}`
        if (BLOCKING_IMPACTS.has(violation.impact ?? '') && !isKnownIssue(violation.id, target)) blocking.push(line)
        else reported.push(line)
      }
    }
  })
  // Moderate/minor findings and known issues are reported, not failed on.
  if (reported.length) test.info().annotations.push({ type: 'axe (not failing)', description: reported.join('\n') })
  expect(blocking, 'serious/critical axe violations').toEqual([])
})
