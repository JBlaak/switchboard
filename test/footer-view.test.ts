import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installConfirmation, quotaGaugeView, updateNoticeView } from '../src/renderer/ui/footer/footer-view';
import { usageGaugeRows } from '../src/domain/usage/usage';
import type { UsageLimit } from '../src/domain/usage/usage';
import type { UpdateNotice } from '../src/domain/update/release';

const sessionAt = (percent: number): UsageLimit => ({
  kind: 'session', label: 'Current session', model: null, percent, reset: '6pm (UTC)', severity: 'normal',
});

const weekAt = (percent: number): UsageLimit => ({
  kind: 'weekly_all', label: 'Week (all models)', model: null, percent, reset: 'Jun 12 at 9am (UTC)', severity: 'normal',
});

const notice = (installable = true): UpdateNotice => ({
  version: '9.1.0', pageUrl: 'https://example.com/v9.1.0', installable,
});

const idle = { installing: false, failed: false };

// ── Quota gauges ──

test('a gauge is titled short, with the full label, percentage and reset in its tooltip', () => {
  /* When */
  const gauges = [sessionAt(42), weekAt(67)].map(quotaGaugeView);

  /* Then */
  assert.deepEqual(gauges.map(g => [g.label, g.percentText, g.tooltip]), [
    ['5h', '42%', 'Current session: 42% — resets 6pm (UTC)'],
    ['Week', '67%', 'Week (all models): 67% — resets Jun 12 at 9am (UTC)'],
  ]);
});

test('a gauge without a reset leaves it out of the tooltip', () => {
  /* When */
  const gauge = quotaGaugeView({ ...sessionAt(42), reset: null });

  /* Then */
  assert.equal(gauge.tooltip, 'Current session: 42%');
});

test('the 5-hour gauge is coloured from 60% and again from 80%', () => {
  /* When */
  const classes = [0, 59, 60, 79, 80, 100].map(p => quotaGaugeView(sessionAt(p)).fillClass);

  /* Then */
  assert.deepEqual(classes, [
    'quota-fill', 'quota-fill', 'quota-fill quota-mid', 'quota-fill quota-mid', 'quota-fill quota-high', 'quota-fill quota-high',
  ]);
});

test('the weekly gauge is coloured from 80% and again from 90%', () => {
  /* When */
  const classes = [0, 79, 80, 89, 90, 100].map(p => quotaGaugeView(weekAt(p)).fillClass);

  /* Then */
  assert.deepEqual(classes, [
    'quota-fill', 'quota-fill', 'quota-fill quota-mid', 'quota-fill quota-mid', 'quota-fill quota-high', 'quota-fill quota-high',
  ]);
});

test('a gauge never draws less than 1% or more than 100%', () => {
  /* When */
  const widths = [0, 1, 80, 130].map(p => quotaGaugeView(sessionAt(p)).width);

  /* Then */
  assert.deepEqual(widths, ['1%', '1%', '80%', '100%']);
});

test('no usage means no gauges', () => {
  /* When */
  const rows = usageGaugeRows(null);

  /* Then */
  assert.deepEqual(rows, []);
});

test('only the shared windows get a gauge, not the per-model ones', () => {
  /* Given */
  const perModel: UsageLimit = { ...weekAt(30), kind: 'weekly_model', label: 'Week (Opus)', model: 'Opus' };

  /* When */
  const rows = usageGaugeRows({ limits: [sessionAt(42), perModel, weekAt(67)] });

  /* Then */
  assert.deepEqual(rows.map(r => r.label), ['Current session', 'Week (all models)']);
});

// ── Update notice ──

test('an installable release offers Install, which replaces the app', () => {
  /* When */
  const shown = updateNoticeView(notice(), idle);

  /* Then */
  assert.deepEqual(shown, {
    label: 'Version 9.1.0 is available', action: 'Install', actionTitle: 'Download, replace this app and restart',
  });
});

test('a release the app cannot install itself offers the release page instead', () => {
  /* When */
  const shown = updateNoticeView(notice(false), idle);

  /* Then */
  assert.deepEqual([shown.action, shown.actionTitle], ['View', 'Open the release page']);
});

test('an install under way says so', () => {
  /* When */
  const shown = updateNoticeView(notice(), { installing: true, failed: false });

  /* Then */
  assert.deepEqual([shown.label, shown.action], ['Version 9.1.0 is available', 'Installing…']);
});

test('a failed install says so and offers a retry', () => {
  /* When */
  const shown = updateNoticeView(notice(), { installing: false, failed: true });

  /* Then */
  assert.deepEqual([shown.label, shown.action], ['Update failed', 'Retry']);
});

test('installing with nothing running asks nothing', () => {
  /* When */
  const question = installConfirmation(0);

  /* Then */
  assert.equal(question, null);
});

test('installing with sessions running asks first, counting them', () => {
  /* When */
  const questions = [1, 2].map(installConfirmation);

  /* Then */
  assert.deepEqual(questions, [
    'Restarting to update stops 1 running session. Install now?',
    'Restarting to update stops 2 running sessions. Install now?',
  ]);
});
