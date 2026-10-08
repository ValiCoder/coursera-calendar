import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DAY, buildSchedule, completeCourse, dayISO, migrateState,
  reminderOrder, reminderTarget, trackCourses, validateState
} from './core.mjs';
import { applyAction, createState, effectivePlan } from './profile.mjs';

const plan = JSON.parse(fs.readFileSync(new URL('./data/plan.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const addedId = 'entrepreneurship-ai-strategy';
const added = plan.Courses.find(c => c.Id === addedId);
const now = new Date('2026-10-10T12:00:00.000Z');
const cutoff = Math.floor(Date.parse('2026-10-10') / DAY);
const oldPlan = structuredClone(plan);
oldPlan.Courses = oldPlan.Courses.filter(c => c.Id !== addedId);
delete oldPlan.CatalogRevision;
for (const course of oldPlan.Courses) delete course.AddedInCatalogRevision;
for (const [trackId, order] of Object.entries(oldPlan.FutureCourseOrder)) oldPlan.FutureCourseOrder[trackId] = order.filter(id => id !== addedId);
const originalPlan = structuredClone(oldPlan);
delete originalPlan.PlanningRevision;
delete originalPlan.ReorderAfterDate;
delete originalPlan.FutureCourseOrder;

function existingState(schema = 3, start = '2026-10-07', at = now) {
  const state = createState(oldPlan, at, start);
  state.SchemaVersion = schema;
  delete state.CatalogRevision;
  return state;
}
function ranges(sourcePlan, state, at = now) {
  return Object.fromEntries(buildSchedule(sourcePlan, state, at).tracks.flatMap(t => t.courses.map(c => [c.Id, { start:c.start, end:c.end, days:c.days }])));
}
function previousView(state) {
  const copy = structuredClone(state);
  delete copy.SchemaVersion;
  delete copy.CatalogRevision;
  delete copy.CoursePlanStart?.[addedId];
  if (copy.CourseOrder?.entrepreneurship) copy.CourseOrder.entrepreneurship = copy.CourseOrder.entrepreneurship.filter(id => id !== addedId);
  return copy;
}
function preserveFacts(state) {
  state.Progress['qa-quality-testing'] = 60;
  completeCourse(oldPlan, state, 'qa-quality-testing', new Date('2026-10-08T12:00:00.000Z'));
  state.Progress['qa-modern-testing-tools'] = 55;
  state.Progress['architecture-design'] = 70;
  state.Progress['entrepreneurship-educate'] = 25;
  state.TrackActualStart = { qa:'2026-10-06', architecture:'2026-10-06', security:'2026-10-08' };
  state.SubcourseProgress = { 'entrepreneurship-scaleup':[100,30,0,0], 'security-analyst':[60,0,0] };
  state.NotificationsEnabled = true;
  state.NextNotificationUtc = '2026-10-10T12:30:00.000Z';
  state.SnoozeUtc = '2026-10-10T13:00:00.000Z';
  state.SubscriptionEndDate = null;
  state.ApplicationStartDate = '2026-11-02';
  state.ApplicationEndDate = '2026-11-08';
  state.SelectedId = 'architecture-api-start';
  state.ReminderCursor = 17;
  return state;
}
function assertCompleteOrders(state) {
  for (const track of plan.Tracks) {
    const ids = trackCourses(plan, state, track.Id).map(c => c.Id);
    const expected = plan.Courses.filter(c => c.TrackId === track.Id).map(c => c.Id);
    assert.equal(new Set(ids).size, expected.length, track.Id);
    assert.deepEqual(ids.toSorted(), expected.toSorted(), track.Id);
  }
}

test('the AI course adds six hours outside the PDF without removing any required course', () => {
  assert.equal(plan.CatalogRevision, 1);
  assert.equal(added.AddedInCatalogRevision, 1);
  assert.equal(added.Title, 'How to Build an Entrepreneurial AI Strategy');
  assert.equal(added.Url, 'https://www.coursera.org/learn/how-to-build-an-entrepreneurial-ai-strategy');
  assert.equal(added.Hours, 6);
  assert.equal(added.Program, 'technological');
  assert.equal(added.CreditPlanRole, 'additional');
  assert.ok(added.IncludedCourses.every(c => c.InCreditPlan === false));
  assert.equal(plan.Courses.reduce((sum, c) => sum + c.Hours, 0), 832);
  const technological = plan.Courses.filter(c => c.TrackId === 'entrepreneurship');
  assert.equal(technological.reduce((sum, c) => sum + c.Hours, 0), 172);
  assert.equal(technological.filter(c => c.Availability !== 'unconfirmed').reduce((sum, c) => sum + c.Hours, 0), 151);
  const required = plan.Courses.flatMap(c => c.IncludedCourses || []).filter(c => c.InCreditPlan).map(c => c.Title);
  assert.equal(required.length, 47);
  assert.equal(new Set(required).size, 47);
  assert.equal(plan.Courses.filter(c => c.Id === addedId).length, 1);
});

test('an existing schema 3 profile appends one row and preserves all old facts, dates and settings', () => {
  const state = preserveFacts(existingState()), before = structuredClone(state), beforeRanges = ranges(oldPlan, state);
  assert.equal(state.PlanningRevision, 1);
  assert.equal(migrateState(plan, state), true);
  assert.equal(state.SchemaVersion, 4);
  assert.equal(state.CatalogRevision, 1);
  assert.deepEqual(previousView(state), previousView(before));
  const after = ranges(plan, state);
  for (const [id, range] of Object.entries(beforeRanges)) assert.deepEqual(after[id], range, id);
  assert.deepEqual(state.CourseOrder.entrepreneurship, [...before.CourseOrder.entrepreneurship, addedId]);
  const lastEnd = Math.max(...oldPlan.Courses.filter(c => c.TrackId === 'entrepreneurship').map(c => beforeRanges[c.Id].end));
  assert.equal(after[addedId].start, lastEnd + 1);
  assert.equal(after[addedId].days, 1);
  assert.equal(state.Progress[addedId] || 0, 0);
  assert.ok(!state.CourseStarted[addedId]);
  assert.ok(!state.CourseCompleted[addedId]);
  assertCompleteOrders(state);
  validateState(plan, state);
});

test('a pre-order schema 2 profile retains protected ranges and completion history while gaining the new catalog', () => {
  const state = createState(originalPlan, now, '2026-10-06');
  state.SchemaVersion = 2;
  state.Progress['qa-modern-testing-tools'] = 39;
  completeCourse(originalPlan, state, 'qa-quality-testing', new Date('2026-10-08T12:00:00.000Z'));
  const before = structuredClone(state), beforeRanges = ranges(originalPlan, state);
  assert.equal(migrateState(plan, state), true);
  const after = ranges(plan, state);
  for (const [id, range] of Object.entries(beforeRanges)) if (range.start <= cutoff) assert.deepEqual(after[id], range, id);
  for (const key of ['TrackStarted','TrackPlanStart','CourseStarted','CourseCompleted','Progress','ProgressBeforeComplete','SelectedId']) assert.deepEqual(state[key], before[key], key);
  assert.equal(state.SchemaVersion, 4);
  assert.equal(state.PlanningRevision, 1);
  assert.equal(state.CatalogRevision, 1);
  assert.equal(state.CourseOrder.entrepreneurship.at(-1), addedId);
  assert.equal(state.Progress[addedId] || 0, 0);
  assertCompleteOrders(state);
  validateState(plan, state);
});

test('schema 1 restoration keeps its original October prefix and facts before ordering and adding the course', () => {
  const state = createState(originalPlan, now, '2026-10-06');
  completeCourse(originalPlan, state, 'qa-quality-testing', new Date('2026-10-08T12:00:00.000Z'));
  state.Progress['entrepreneurship-scaleup'] = 47;
  state.SchemaVersion = 1;
  delete state.CoursePlanStart;
  delete state.ProgressBeforeComplete;
  const facts = structuredClone({ started:state.CourseStarted, completed:state.CourseCompleted, progress:state.Progress, track:state.TrackStarted });
  migrateState(plan, state);
  const after = ranges(plan, state);
  assert.equal(dayISO(after['qa-quality-testing'].start), '2026-10-06');
  assert.equal(dayISO(after['qa-practical-testing'].start), '2026-10-08');
  assert.equal(dayISO(after['qa-modern-testing-tools'].start), '2026-10-10');
  assert.equal(dayISO(after['qa-modern-testing-tools'].end), '2026-10-12');
  assert.deepEqual({ started:state.CourseStarted, completed:state.CourseCompleted, progress:state.Progress, track:state.TrackStarted }, facts);
  assert.deepEqual(state.ProgressBeforeComplete, {});
  assert.ok(after[addedId].start > cutoff);
  assert.equal(state.SchemaVersion, 4);
  assertCompleteOrders(state);
  validateState(plan, state);
});

test('catalog addition never reruns a completed planning revision or replaces a personal future order', () => {
  const state = existingState();
  state.CourseOrder.entrepreneurship = ['entrepreneurship-scaleup','entrepreneurship-pr','entrepreneurship-business-model','entrepreneurship-it','entrepreneurship-educate','entrepreneurship-launching'];
  state.CourseOrder.architecture = [...state.CourseOrder.architecture].reverse();
  const before = structuredClone(state);
  migrateState(plan, state);
  assert.deepEqual(previousView(state), previousView(before));
  assert.deepEqual(state.CourseOrder.entrepreneurship, [...before.CourseOrder.entrepreneurship, addedId]);
  assert.deepEqual(state.CourseOrder.architecture, before.CourseOrder.architecture);
  assertCompleteOrders(state);
  validateState(plan, state);
});

test('the added row follows the latest existing planned end even when it is not the last ordered row', () => {
  const state = existingState();
  state.CoursePlanStart['entrepreneurship-it'] = '2026-12-01';
  state.CoursePlanStart['entrepreneurship-educate'] = '2026-10-18';
  const before = structuredClone(state), beforeRanges = ranges(oldPlan, state);
  migrateState(plan, state);
  const after = ranges(plan, state);
  assert.equal(state.CoursePlanStart[addedId], '2026-12-05');
  for (const [id, range] of Object.entries(beforeRanges)) assert.deepEqual(after[id], range, id);
  assert.deepEqual(previousView(state), previousView(before));
  validateState(plan, state);
});

test('a private future track start is a lower bound for the new row without moving old saved rows', () => {
  const state = existingState();
  state.TrackPlanStart.entrepreneurship = '2026-12-20';
  const before = structuredClone(state);
  migrateState(plan, state);
  assert.equal(state.CoursePlanStart[addedId], '2026-12-20');
  assert.deepEqual(previousView(state), previousView(before));
  validateState(plan, state);
});

test('historical dates before the protected period cannot place the added course on or before October 10', () => {
  const state = existingState(3, '2026-09-01', new Date('2026-09-01T12:00:00.000Z'));
  for (const course of oldPlan.Courses.filter(c => c.TrackId === 'entrepreneurship')) state.CoursePlanStart[course.Id] = '2026-09-01';
  state.TrackPlanStart.entrepreneurship = '2026-09-01';
  const before = structuredClone(state);
  migrateState(plan, state);
  assert.equal(state.CoursePlanStart[addedId], '2026-10-11');
  assert.deepEqual(previousView(state), previousView(before));
  validateState(plan, state);
});

test('catalog migration is idempotent and does not undo later personal edits', () => {
  let state = existingState();
  migrateState(plan, state);
  const migrated = structuredClone(state);
  assert.equal(migrateState(plan, state), false);
  assert.deepEqual(state, migrated);
  state = applyAction(plan, state, { type:'reschedule', trackId:'entrepreneurship', date:'2026-10-20' }, now);
  state = applyAction(plan, state, { type:'progress', id:addedId, value:40 }, now);
  state.CourseOrder.entrepreneurship = [state.CourseOrder.entrepreneurship[0], addedId, ...state.CourseOrder.entrepreneurship.slice(1).filter(id => id !== addedId)];
  const edited = structuredClone(state);
  assert.equal(migrateState(plan, state), false);
  assert.deepEqual(state, edited);
  validateState(plan, state);
});

test('general entrepreneurship hides the added course but preserves its private technological queue', () => {
  const state = preserveFacts(existingState());
  state.Program = 'general';
  migrateState(plan, state);
  const saved = structuredClone(state);
  const current = effectivePlan(plan, state);
  assert.ok(current.Tracks.every(t => t.Id !== 'entrepreneurship'));
  assert.ok(current.Courses.every(c => c.Id !== addedId));
  assert.ok(reminderOrder(current, state).every(c => c.Id !== addedId));
  const switched = applyAction(plan, state, { type:'program', program:'technological' }, now);
  assert.ok(effectivePlan(plan, switched).Courses.some(c => c.Id === addedId));
  assert.deepEqual(switched.CoursePlanStart, saved.CoursePlanStart);
  assert.deepEqual(switched.CourseOrder, saved.CourseOrder);
  assert.deepEqual(switched.Progress, saved.Progress);
  assert.deepEqual(switched.CourseCompleted, saved.CourseCompleted);
  validateState(plan, switched);
});

test('a personally deferred Educate course keeps its range and partial progress after the addition', () => {
  const state = existingState();
  state.Progress['entrepreneurship-educate'] = 25;
  state.DeferredCourses = { 'entrepreneurship-educate':true };
  const before = structuredClone(state);
  migrateState(plan, state);
  assert.deepEqual(previousView(state), previousView(before));
  assert.equal(state.Progress['entrepreneurship-educate'], 25);
  assert.equal(ranges(plan, state)['entrepreneurship-educate'].start, ranges(oldPlan, before)['entrepreneurship-educate'].start);
  state.ReminderCursor = reminderOrder(plan, state).findIndex(c => c.Id === 'entrepreneurship-educate');
  assert.notEqual(reminderTarget(plan, state, now).course.Id, 'entrepreneurship-educate');
  assert.ok(!state.DeferredCourses[addedId]);
  validateState(plan, state);
});

test('even a previously finished entrepreneurship track gains an incomplete course with no fabricated progress', () => {
  const at = new Date('2026-11-03T12:00:00.000Z'), state = existingState(3, '2026-10-07', at);
  for (const course of oldPlan.Courses.filter(c => c.TrackId === 'entrepreneurship')) {
    state.CourseStarted[course.Id] = '2026-10-07T12:00:00.000Z';
    state.CourseCompleted[course.Id] = '2026-11-03T12:00:00.000Z';
    state.Progress[course.Id] = 100;
  }
  const before = structuredClone(state);
  assert.equal(buildSchedule(oldPlan, state, at).tracks.find(t => t.Id === 'entrepreneurship').finished, true);
  migrateState(plan, state);
  const track = buildSchedule(plan, state, at).tracks.find(t => t.Id === 'entrepreneurship');
  assert.equal(track.finished, false);
  assert.equal(track.courses.find(c => c.active).Id, addedId);
  assert.equal(track.courses.find(c => c.Id === addedId).progress, 0);
  assert.ok(!state.CourseCompleted[addedId]);
  assert.ok(!state.CourseStarted[addedId]);
  assert.deepEqual(previousView(state), previousView(before));
  validateState(plan, state);
});

test('fresh visitors have complete queues and zero progress without another visitor facts or preferences', () => {
  const a = preserveFacts(existingState(3, '2026-10-06'));
  migrateState(plan, a);
  const b = createState(plan, new Date('2026-10-20T12:00:00.000Z'), '2026-10-20');
  assert.equal(b.SchemaVersion, 4);
  assert.equal(b.CatalogRevision, 1);
  assert.equal(b.PlanningRevision, 1);
  assert.deepEqual(b.Progress, {});
  assert.deepEqual(b.CourseCompleted, {});
  assert.deepEqual(b.ProgressBeforeComplete, {});
  assert.ok(!b.TrackActualStart);
  assert.equal(b.NotificationsEnabled, false);
  assert.equal(b.SubscriptionEndDate, '2026-11-05');
  assert.equal(b.CourseOrder.entrepreneurship.at(-1), addedId);
  const newStart = ranges(plan, b)[addedId].start;
  assert.ok(newStart >= Math.floor(Date.parse('2026-10-20') / DAY));
  assertCompleteOrders(b);
  a.Progress[addedId] = 99;
  a.CourseOrder.entrepreneurship.reverse();
  a.CoursePlanStart[addedId] = '2026-12-01';
  assert.equal(b.Progress[addedId] || 0, 0);
  assert.equal(b.CourseOrder.entrepreneurship.at(-1), addedId);
  assert.equal(ranges(plan, b)[addedId].start, newStart);
  validateState(plan, b);
});

test('a legacy settings action can trigger migration without clearing omitted personal deadlines or progress', () => {
  const original = preserveFacts(existingState()), saved = structuredClone(original);
  const result = applyAction(plan, original, { type:'settings', program:'technological', dates:[] }, now);
  assert.deepEqual(original, saved);
  assert.equal(result.SchemaVersion, 4);
  assert.equal(result.CatalogRevision, 1);
  for (const key of ['SubscriptionEndDate','ApplicationStartDate','ApplicationEndDate','Progress','CourseCompleted','CourseStarted','CoursePlanStart']) {
    if (key === 'CoursePlanStart') {
      const starts = { ...result.CoursePlanStart }; delete starts[addedId];
      assert.deepEqual(starts, saved.CoursePlanStart);
    } else assert.deepEqual(result[key], saved[key], key);
  }
  assert.equal(result.CourseOrder.entrepreneurship.at(-1), addedId);
  assertCompleteOrders(result);
});

test('a current catalog revision rejects incomplete old-tab order data instead of silently resetting it', () => {
  const state = existingState();
  state.SchemaVersion = 4;
  state.CatalogRevision = 1;
  const saved = structuredClone(state);
  assert.equal(migrateState(plan, state), false);
  assert.deepEqual(state, saved);
  assert.throws(() => validateState(plan, state), /порядок курсов/);
});
