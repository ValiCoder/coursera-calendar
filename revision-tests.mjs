import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSchedule, completeCourse, reschedule, reminderTarget, reminderOrder, validateState, dayISO, migrateState, trackCourses } from './core.mjs';
import { createState, effectivePlan, applyAction } from './profile.mjs';

const legacyPlan = JSON.parse(fs.readFileSync(new URL('./data/plan.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
delete legacyPlan.PlanningRevision;
delete legacyPlan.ReorderAfterDate;
delete legacyPlan.FutureCourseOrder;
const now = new Date('2026-10-10T12:00Z');
const cutoff = Math.floor(Date.parse('2026-10-10') / 86400000);
const ids = (plan, trackId) => plan.Courses.filter(c => c.TrackId === trackId).map(c => c.Id);
function revisionPlan() {
  const plan = structuredClone(legacyPlan);
  plan.PlanningRevision = 1;
  plan.ReorderAfterDate = '2026-10-10';
  plan.FutureCourseOrder = Object.fromEntries(plan.Tracks.map(t => [t.Id, ids(plan, t.Id).reverse()]));
  // Move a genuinely later module ahead of the future QA queue; frozen rows must resist this preference.
  const priority = ['qa-istqb', 'qa-advanced-capstone', 'qa-modern-testing-tools', 'qa-practical-testing', 'qa-quality-testing'];
  plan.FutureCourseOrder.qa = [...priority, ...ids(plan, 'qa').filter(id => !priority.includes(id))];
  return plan;
}
function legacyState(start = '2026-10-07', at = now) {
  const state = createState(legacyPlan, at, start);
  state.SchemaVersion = 2;
  delete state.PlanningRevision;
  delete state.CourseOrder;
  return state;
}
function courseRanges(plan, state, at = now) {
  return Object.fromEntries(buildSchedule(plan, state, at).tracks.flatMap(t => t.courses.map(c => [c.Id, { start:c.start, end:c.end, days:c.days }])));
}
const preservedFields = [
  'TrackStarted', 'TrackActualStart', 'TrackPlanStart', 'CourseStarted', 'CourseCompleted',
  'Progress', 'ProgressBeforeComplete', 'SubcourseProgress', 'SelectedId', 'ReminderCursor',
  'Program', 'NotificationsEnabled', 'NextNotificationUtc', 'SnoozeUtc',
  'SubscriptionEndDate', 'ApplicationStartDate', 'ApplicationEndDate'
];

test('6, 7 and 8 October starts retain every frozen range and the original prefix order', () => {
  const cases = [
    ['2026-10-06', ['qa-quality-testing','qa-practical-testing','qa-modern-testing-tools'], '2026-10-13'],
    ['2026-10-07', ['qa-quality-testing','qa-practical-testing'], '2026-10-11'],
    ['2026-10-08', ['qa-quality-testing','qa-practical-testing'], '2026-10-12']
  ];
  for (const [start, prefix, nextStart] of cases) {
    const plan = revisionPlan(), state = legacyState(start), before = courseRanges(legacyPlan, state);
    assert.equal(migrateState(plan, state), true, start);
    const after = courseRanges(plan, state);
    for (const [id, range] of Object.entries(before)) if (range.start <= cutoff) assert.deepEqual(after[id], range, id);
    const order = trackCourses(plan, state, 'qa').map(c => c.Id);
    assert.deepEqual(order.slice(0, prefix.length), prefix, start);
    assert.equal(order[prefix.length], 'qa-istqb', start);
    assert.equal(dayISO(after['qa-istqb'].start), nextStart, start);
    validateState(plan, state);
  }
});

test('future QA order changes active-course succession without rewriting the frozen dates', () => {
  const plan = revisionPlan(), state = legacyState(), before = courseRanges(legacyPlan, state);
  migrateState(plan, state);
  assert.deepEqual(trackCourses(plan, state, 'qa').map(c => c.Id).slice(0, 5), [
    'qa-quality-testing','qa-practical-testing','qa-istqb','qa-advanced-capstone','qa-modern-testing-tools'
  ]);
  const ranges = courseRanges(plan, state);
  assert.deepEqual(ranges['qa-quality-testing'], before['qa-quality-testing']);
  assert.deepEqual(ranges['qa-practical-testing'], before['qa-practical-testing']);
  assert.equal(dayISO(ranges['qa-istqb'].start), '2026-10-11');
  assert.equal(dayISO(ranges['qa-istqb'].end), '2026-10-15');
  completeCourse(plan, state, 'qa-quality-testing', now);
  completeCourse(plan, state, 'qa-practical-testing', now);
  const active = buildSchedule(plan, state, now).tracks.find(t => t.Id === 'qa').courses.find(c => c.active);
  assert.equal(active.Id, 'qa-istqb');
  assert.deepEqual(reminderOrder(plan, state).filter(c => c.TrackId === 'qa').map(c => c.Id), trackCourses(plan, state, 'qa').map(c => c.Id));
  state.ReminderCursor = reminderOrder(plan, state).findIndex(c => c.Id === 'qa-istqb');
  assert.equal(reminderTarget(plan, state, now).course.Id, 'qa-istqb');
  assert.equal(state.SelectedId, 'qa-istqb');
});

test('a personal start after the cutoff begins the preferred order on that start date', () => {
  const plan = revisionPlan(), state = legacyState('2026-10-20');
  migrateState(plan, state);
  const courses = buildSchedule(plan, state, now).tracks.find(t => t.Id === 'qa').courses;
  assert.equal(courses[0].Id, 'qa-istqb');
  assert.equal(dayISO(courses[0].start), '2026-10-20');
  assert.equal(dayISO(Math.min(...courses.map(c => c.start))), '2026-10-20');
  assert.deepEqual(state.CourseStarted, {});
});

test('individual shifted and overlapping frozen ranges are preserved rather than reconstructed', () => {
  const plan = revisionPlan(), state = legacyState();
  completeCourse(legacyPlan, state, 'qa-quality-testing', new Date('2026-10-08T12:00Z'));
  reschedule(legacyPlan, state, '2026-10-05', 'qa');
  const before = courseRanges(legacyPlan, state), completed = structuredClone(state.CourseCompleted);
  assert.equal(dayISO(before['qa-quality-testing'].start), '2026-10-07');
  assert.equal(dayISO(before['qa-practical-testing'].start), '2026-10-07');
  assert.equal(dayISO(before['qa-modern-testing-tools'].start), '2026-10-09');
  migrateState(plan, state);
  const after = courseRanges(plan, state);
  for (const id of ['qa-quality-testing','qa-practical-testing','qa-modern-testing-tools']) assert.deepEqual(after[id], before[id]);
  assert.equal(dayISO(after['qa-istqb'].start), '2026-10-12');
  assert.deepEqual(state.CourseCompleted, completed);
  assert.equal(state.TrackPlanStart.qa, '2026-10-05');
});

test('a private security start remains private while other tracks retain their original ranges', () => {
  const plan = revisionPlan(), state = legacyState('2026-10-07', new Date('2026-10-06T12:00Z'));
  for (const track of plan.Tracks) if (track.Id !== 'security') plan.FutureCourseOrder[track.Id] = ids(plan, track.Id);
  reschedule(legacyPlan, state, '2026-10-20', 'security');
  const before = courseRanges(legacyPlan, state), starts = structuredClone(state.CourseStarted);
  migrateState(plan, state);
  const after = courseRanges(plan, state);
  for (const course of legacyPlan.Courses) if (course.TrackId !== 'security') assert.deepEqual(after[course.Id], before[course.Id]);
  assert.equal(trackCourses(plan, state, 'security')[0].Id, 'security-ec-council');
  assert.equal(dayISO(after['security-ec-council'].start), '2026-10-20');
  assert.equal(state.TrackPlanStart.qa, '2026-10-07');
  assert.equal(state.TrackPlanStart.security, '2026-10-20');
  assert.deepEqual(state.CourseStarted, starts);
});

test('revision migration leaves factual dates, percentages, subcourses and personal settings intact', () => {
  const plan = revisionPlan(), state = legacyState();
  completeCourse(legacyPlan, state, 'qa-quality-testing', new Date('2026-10-08T12:00Z'));
  state.Progress['qa-modern-testing-tools'] = 55;
  state.Progress['architecture-design'] = 70;
  state.TrackActualStart = { qa:'2026-10-06', architecture:'2026-10-06', security:'2026-10-08' };
  state.SubcourseProgress = { 'entrepreneurship-scaleup':[100,30,0,0], 'security-analyst':[60,0,0] };
  state.SubscriptionEndDate = null;
  state.ApplicationStartDate = '2026-11-02';
  state.ApplicationEndDate = '2026-11-08';
  state.NotificationsEnabled = true;
  state.NextNotificationUtc = '2026-10-10T12:30:00.000Z';
  state.SnoozeUtc = '2026-10-10T13:00:00.000Z';
  const before = structuredClone(state);
  migrateState(plan, state);
  for (const field of preservedFields) assert.deepEqual(state[field], before[field], field);
  validateState(plan, state);
});

test('an actual start through UTC+5 10 October locks a whole later planned bar', () => {
  for (const [startedAt, locked] of [
    ['2026-10-10T18:59:59.999Z', true],
    ['2026-10-10T19:00:00.000Z', false]
  ]) {
    const plan = revisionPlan(), state = legacyState(), before = courseRanges(legacyPlan, state);
    state.CourseStarted['qa-modern-testing-tools'] = startedAt;
    state.Progress['qa-modern-testing-tools'] = 55;
    migrateState(plan, state);
    const after = courseRanges(plan, state);
    const order = trackCourses(plan, state, 'qa').map(c => c.Id);
    assert.equal(order[2], locked ? 'qa-modern-testing-tools' : 'qa-istqb', startedAt);
    assert.equal(dayISO(after['qa-istqb'].start), locked ? '2026-10-14' : '2026-10-11', startedAt);
    if (locked) assert.deepEqual(after['qa-modern-testing-tools'], before['qa-modern-testing-tools']);
    assert.equal(state.CourseStarted['qa-modern-testing-tools'], startedAt);
    assert.equal(state.Progress['qa-modern-testing-tools'], 55);
  }
});

test('an already completed future row keeps its individual range when the remaining queue moves', () => {
  const plan = revisionPlan(), at = new Date('2026-11-03T12:00Z'), state = legacyState('2026-10-07', at);
  state.CourseStarted['qa-istqb'] = '2026-11-02T12:00:00.000Z';
  state.CourseCompleted['qa-istqb'] = '2026-11-03T12:00:00.000Z';
  state.Progress['qa-istqb'] = 100;
  const before = courseRanges(legacyPlan, state, at);
  migrateState(plan, state);
  const after = courseRanges(plan, state, at);
  assert.deepEqual(after['qa-istqb'], before['qa-istqb']);
  assert.equal(state.CourseCompleted['qa-istqb'], '2026-11-03T12:00:00.000Z');
  assert.deepEqual(trackCourses(plan, state, 'qa').map(c => c.Id).slice(0, 3), ['qa-quality-testing','qa-practical-testing','qa-istqb']);
  assert.ok(after['qa-advanced-capstone'].start > after['qa-istqb'].end);
  validateState(plan, state);
});

test('reapplying a revision does not erase later personal rescheduling or edits', () => {
  const plan = revisionPlan(), state = legacyState();
  migrateState(plan, state);
  const first = structuredClone(state);
  assert.equal(migrateState(plan, state), false);
  assert.deepEqual(state, first);
  reschedule(plan, state, '2026-10-20', 'qa');
  state.Progress['qa-modern-testing-tools'] = 48;
  const edited = structuredClone(state);
  assert.equal(migrateState(plan, state), false);
  assert.deepEqual(state, edited);
  const selected = applyAction(plan, state, { type:'select', id:'qa-modern-testing-tools' }, now);
  assert.deepEqual(selected.CoursePlanStart, edited.CoursePlanStart);
  assert.deepEqual(selected.CourseOrder, edited.CourseOrder);
  assert.equal(selected.Progress['qa-modern-testing-tools'], 48);
});

test('general entrepreneurship hides its revised queue without removing its saved personal data', () => {
  const plan = revisionPlan(), state = legacyState();
  state.Program = 'general';
  state.Progress['entrepreneurship-scaleup'] = 37;
  state.TrackActualStart = { entrepreneurship:'2026-10-06' };
  migrateState(plan, state);
  const savedOrder = [...state.CourseOrder.entrepreneurship];
  const current = effectivePlan(plan, state);
  assert.equal(buildSchedule(current, state, now).tracks.length, 3);
  for (let i = 0; i < legacyPlan.Courses.length; i++) {
    state.ReminderCursor = i;
    assert.notEqual(reminderTarget(current, state, now).course.TrackId, 'entrepreneurship');
  }
  const switched = applyAction(plan, state, { type:'program', program:'technological' }, now);
  assert.equal(buildSchedule(plan, switched, now).tracks.length, 4);
  assert.deepEqual(switched.CourseOrder.entrepreneurship, savedOrder);
  assert.equal(switched.Progress['entrepreneurship-scaleup'], 37);
  assert.equal(switched.TrackActualStart.entrepreneurship, '2026-10-06');
});

test('every course appears once and fresh visitors receive no other visitor progress or October history', () => {
  const plan = revisionPlan(), a = legacyState(), b = createState(plan, new Date('2026-10-20T12:00Z'), '2026-10-20');
  migrateState(plan, a);
  for (const state of [a, b]) {
    for (const track of plan.Tracks) {
      const ordered = trackCourses(plan, state, track.Id).map(c => c.Id);
      assert.equal(ordered.length, new Set(ordered).size);
      assert.deepEqual([...ordered].sort(), ids(plan, track.Id).sort());
    }
    validateState(plan, state);
  }
  assert.deepEqual(b.CourseCompleted, {});
  assert.deepEqual(b.Progress, {});
  assert.deepEqual(b.ProgressBeforeComplete, {});
  assert.equal(b.NotificationsEnabled, false);
  assert.ok(!Object.values(b.TrackActualStart || {}).includes('2026-10-06'));
  assert.ok(!Object.values(b.TrackStarted).some(value => value.startsWith('2026-10-06')));
  assert.equal(dayISO(courseRanges(plan, b)['qa-istqb'].start), '2026-10-20');
  a.Progress['qa-modern-testing-tools'] = 99;
  a.CourseOrder.qa.reverse();
  assert.deepEqual(b.Progress, {});
  assert.equal(trackCourses(plan, b, 'qa')[0].Id, 'qa-istqb');
});

test('schema 1 restoration precedes future ordering and keeps completion history', () => {
  const plan = revisionPlan(), state = legacyState('2026-10-06');
  completeCourse(legacyPlan, state, 'qa-quality-testing', new Date('2026-10-08T12:00Z'));
  state.SchemaVersion = 1;
  state.CoursePlanStart = { 'qa-practical-testing':'2026-10-08' };
  delete state.ProgressBeforeComplete;
  const completed = structuredClone(state.CourseCompleted), started = structuredClone(state.CourseStarted);
  assert.equal(migrateState(plan, state), true);
  const ranges = courseRanges(plan, state);
  assert.equal(dayISO(ranges['qa-quality-testing'].start), '2026-10-06');
  assert.equal(dayISO(ranges['qa-practical-testing'].start), '2026-10-08');
  assert.equal(dayISO(ranges['qa-modern-testing-tools'].start), '2026-10-10');
  assert.equal(dayISO(ranges['qa-modern-testing-tools'].end), '2026-10-12');
  assert.equal(dayISO(ranges['qa-istqb'].start), '2026-10-13');
  assert.deepEqual(state.CourseCompleted, completed);
  assert.deepEqual(state.CourseStarted, started);
  validateState(plan, state);
});

test('the expanded catalogue contains all 47 PDF courses and keeps entrepreneurship programs distinct', () => {
  const expected = {
    qa: [
      'Introduction to Software Quality Assurance', 'Automation and Modern Testing Tools',
      'Advanced Quality and Capstone Project', 'Practical Software Testing', 'Introduction to Software Testing',
      'Black-box and White-box Testing', 'Introduction to Automated Analysis', 'Web and Mobile Testing with Selenium'
    ],
    architecture: [
      'Getting Started with APIs', 'Protecting and Managing APIs', 'Object-Oriented Design', 'Design Patterns',
      'Software Architecture', 'Service-Oriented Architecture', 'Fundamentals of Software Architecture for Big Data',
      'Software Architecture Patterns for Big Data', 'Applications of Software Architecture for Big Data',
      'Software Architecture Foundations & Intro to Microservices', 'Microservices Design, Communication, and Data Handling',
      'Advanced Microservices Architecture, Deployment & Resilience'
    ],
    security: [
      'Information Security Fundamentals', 'Ethical Hacking Essentials: Hands-On Edition',
      'Introduction to Cybersecurity Tools & Cyberattacks', 'Penetration Testing, Threat Hunting, and Cryptography',
      'Operating Systems: Overview, Administration, and Security', 'Incident Response and Digital Forensics',
      'Network Defense Essentials: Hands-On Edition', 'Cybersecurity Case Studies and Capstone Project',
      'Cybersecurity Compliance Framework, Standards & Regulations'
    ],
    entrepreneurship: [
      'Why Scale a Startup?', 'Scaling Product and Processes', 'Building Culture in a Scale Up', 'Scale Up Specialization Capstone',
      'Validate New Ideas for Startups', 'Pitching, Marketing and Sales For Startups',
      'Getting Started with IT-based Entrepreneurship', 'The Ideation Process', 'Market Analysis', 'Business Model & Product Pitch',
      'Business Model for Entrepreneurs', 'Developing Innovative Ideas for New Companies: The First Step in Entrepreneurship',
      'Innovation for Entrepreneurs: From Idea to Marketplace', 'New Venture Finance: Startup Funding for Entrepreneurs',
      'Entrepreneurship Capstone', 'Principles of Public Relations', 'Working with the Media', 'The Nuts and Bolts of Public Relations'
    ]
  };
  const required = [];
  for (const [trackId, titles] of Object.entries(expected)) {
    const actual = legacyPlan.Courses.filter(c => c.TrackId === trackId).flatMap(c => c.IncludedCourses || []).filter(c => c.InCreditPlan).map(c => c.Title);
    assert.deepEqual(actual.toSorted(), titles.toSorted(), trackId);
    required.push(...actual);
  }
  assert.equal(required.length, 47);
  assert.equal(new Set(required).size, 47);
  assert.equal(legacyPlan.Courses.reduce((sum, c) => sum + c.Hours, 0), 826);
  assert.ok(legacyPlan.Courses.filter(c => c.TrackId === 'entrepreneurship').every(c => c.Program === 'technological'));
  assert.equal(legacyPlan.Programs.general.Status, 'awaiting-course-list');
  const state = legacyState();state.Program = 'general';
  assert.ok(effectivePlan(legacyPlan, state).Courses.every(c => c.TrackId !== 'entrepreneurship'));
});

test('Educate deferral requires a personal action, preserves its progress and can be reversed', () => {
  const plan = revisionPlan();let state = legacyState();
  state.Progress['entrepreneurship-educate'] = 25;
  migrateState(plan, state);
  assert.ok(!state.DeferredCourses?.['entrepreneurship-educate']);
  completeCourse(plan, state, 'entrepreneurship-scaleup', now);
  const before = structuredClone(state), beforeRanges = courseRanges(plan, state);
  state = applyAction(plan, state, { type:'defer', id:'entrepreneurship-educate', value:true }, now);
  assert.equal(state.DeferredCourses['entrepreneurship-educate'], true);
  assert.deepEqual(state.CourseCompleted, before.CourseCompleted);
  assert.deepEqual(state.Progress, before.Progress);
  assert.equal(state.Progress['entrepreneurship-educate'], 25);
  assert.deepEqual(courseRanges(plan, state), beforeRanges);
  const track = buildSchedule(plan, state, now).tracks.find(t => t.Id === 'entrepreneurship');
  assert.equal(track.courses.find(c => c.Id === 'entrepreneurship-educate').status, 'deferred');
  assert.notEqual(track.courses.find(c => c.active).Id, 'entrepreneurship-educate');
  state.ReminderCursor = reminderOrder(plan, state).findIndex(c => c.Id === 'entrepreneurship-educate');
  assert.notEqual(reminderTarget(plan, state, now).course.Id, 'entrepreneurship-educate');
  const restored = applyAction(plan, state, { type:'defer', id:'entrepreneurship-educate', value:false }, now);
  assert.ok(!restored.DeferredCourses['entrepreneurship-educate']);
  assert.equal(restored.Progress['entrepreneurship-educate'], 25);
  assert.deepEqual(restored.CourseCompleted, before.CourseCompleted);
  assert.deepEqual(courseRanges(plan, restored), beforeRanges);
  assert.equal(buildSchedule(plan, restored, now).tracks.find(t => t.Id === 'entrepreneurship').courses.find(c => c.active).Id, 'entrepreneurship-educate');
  assert.throws(() => applyAction(plan, restored, { type:'defer', id:'qa-quality-testing', value:true }, now), /нельзя отложить/);
  validateState(plan, restored);
});
