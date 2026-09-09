/**
 * The plans tab.
 *
 * A list on the left, the plan itself in an editor on the right. The editor is
 * the shared viewer panel, so a plan can be edited and saved in place — which
 * is the point of the tab: plans are documents Claude wrote for the user to
 * change.
 */
import { view } from '../../state/session-store';
import { plansContent } from '../../lib/dom';
import { formatDate } from '../../lib/format';
import { planPanel } from '../panel/panels';
import { showViewer } from '../panel/viewers';
import type { PlanSummary } from '../../../domain/plans/plan';

export async function loadPlans(): Promise<void> {
  view.cachedPlans = await window.api.getPlans();
  renderPlans();
}

export function renderPlans(plans: readonly PlanSummary[] = view.cachedPlans): void {
  plansContent.innerHTML = '';

  if (plans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No plans found in ~/.claude/plans/';
    plansContent.appendChild(empty);
    return;
  }

  for (const plan of plans) plansContent.appendChild(buildPlanItem(plan));
}

function buildPlanItem(plan: PlanSummary): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item plan-item';

  const info = document.createElement('div');
  info.className = 'session-info';

  const title = document.createElement('div');
  title.className = 'session-summary';
  title.textContent = plan.title;

  const filename = document.createElement('div');
  filename.className = 'session-id';
  filename.textContent = plan.filename;

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.textContent = formatDate(new Date(plan.modified));

  info.append(title, filename, meta);

  const row = document.createElement('div');
  row.className = 'session-row';
  row.appendChild(info);

  item.appendChild(row);
  item.addEventListener('click', () => void openPlan(plan));
  return item;
}

async function openPlan(plan: PlanSummary): Promise<void> {
  markActive(plan);
  const { content, filePath } = await window.api.readPlan(plan.filename);
  showViewer('plan');
  planPanel.open(plan.title, filePath, content);
}

/** Highlight the row whose plan is open, by the filename it renders. */
function markActive(plan: PlanSummary): void {
  plansContent.querySelectorAll<HTMLElement>('.plan-item')
    .forEach(item => item.classList.toggle(
      'active',
      item.querySelector<HTMLElement>('.session-id')?.textContent === plan.filename));
}
