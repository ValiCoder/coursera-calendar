import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSchedule, completeCourse, reschedule, reminderTarget, validateState, clone, dayISO, earliestFinish } from './core.mjs';
import { createState, effectivePlan, applyAction } from './profile.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('./data/plan.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
function fresh(){return createState(plan,new Date('2026-10-08T14:00Z'),'2026-10-07');}
test('baseline matches all 32 modules and the saved 7 Oct–2 Nov schedule',()=>{
  const s=buildSchedule(plan,fresh(),new Date('2026-10-08T14:00Z'));
  assert.equal(s.tracks.flatMap(t=>t.courses).length,32);
  assert.equal(dayISO(s.start),'2026-10-07');assert.equal(dayISO(s.end),'2026-11-02');
  assert.equal(dayISO(s.tracks[0].courses[1].start),'2026-10-09');
  assert.equal(dayISO(s.tracks[2].courses[1].start),'2026-10-09');
});
test('completion starts only the next module in the same track, at the actual time',()=>{
  const state=fresh();completeCourse(plan,state,'qa-quality-testing',new Date('2026-10-08T14:00Z'));
  assert.equal(state.CourseStarted['qa-practical-testing'],'2026-10-08T14:00:00.000Z');
  assert.equal(Object.keys(state.CourseCompleted).length,1);
  assert.throws(()=>completeCourse(plan,state,'qa-modern-testing-tools',new Date('2026-10-08T15:00Z')),/предыдущий/);
  validateState(plan,state);
});
test('shifting start moves future modules but preserves actual completion history',()=>{
  const state=fresh();completeCourse(plan,state,'qa-quality-testing',new Date('2026-10-08T14:00Z'));
  const actual=state.CourseCompleted['qa-quality-testing'];reschedule(plan,state,'2026-10-10');
  const s=buildSchedule(plan,state,new Date('2026-10-08T16:00Z'));
  assert.equal(state.CourseCompleted['qa-quality-testing'],actual);
  assert.equal(dayISO(s.tracks[0].courses[0].end),'2026-10-08');
  assert.equal(dayISO(s.tracks[2].courses[0].start),'2026-10-10');
  assert.equal(dayISO(s.tracks[0].courses[1].start),'2026-10-11');
  assert.equal(dayISO(earliestFinish(plan,state,'architecture')),'2026-11-05');
  assert.throws(()=>completeCourse(plan,state,'architecture-design',new Date('2026-10-08T16:00Z')),/ещё/);
});
test('individual track shift and malformed dates',()=>{
  const state=fresh();reschedule(plan,state,'2026-10-12','security');
  assert.equal(state.TrackPlanStart.qa,'2026-10-07');assert.equal(state.TrackPlanStart.security,'2026-10-12');
  assert.throws(()=>reschedule(plan,state,'2026-02-31'),/корректную/);
});
test('reminders target active courses and skip completed/future rows',()=>{
  const state=fresh();completeCourse(plan,state,'qa-quality-testing',new Date('2026-10-08T14:00Z'));
  assert.equal(reminderTarget(plan,state,new Date('2026-10-08T15:00Z')).course.Id,'security-analyst');
  reschedule(plan,state,'2026-12-01');assert.equal(reminderTarget(plan,state,new Date('2026-10-08T15:00Z')),null);
});
test('last module cannot close a track before its minimum and reserve',()=>{
  const state=fresh(), courses=plan.Courses.filter(c=>c.TrackId==='architecture');
  for(const course of courses.slice(0,-1))completeCourse(plan,state,course.Id,new Date('2026-10-08T14:00Z'));
  assert.throws(()=>completeCourse(plan,state,courses.at(-1).Id,new Date('2026-10-08T15:00Z')),/минимальный/);
});
test('new visitors have separate empty progress, settings and consent',()=>{
 const a=fresh(),b=fresh();assert.deepEqual(a.CourseCompleted,{});assert.deepEqual(a.Progress,{});assert.equal(a.NotificationsEnabled,false);
 const changed=applyAction(plan,a,{type:'progress',id:'architecture-design',value:45});
 assert.equal(changed.Progress['architecture-design'],45);assert.deepEqual(b.Progress,{});assert.deepEqual(a.Progress,{});
 const shifted=applyAction(plan,changed,{type:'reschedule',date:'2026-10-20',trackId:'architecture'});
 assert.equal(b.TrackPlanStart.architecture,'2026-10-07');assert.equal(shifted.TrackPlanStart.architecture,'2026-10-20');
});
test('an untouched future course can start earlier or later',()=>{
 const now=new Date('2026-10-02T12:00Z'),state=createState(plan,now,'2026-10-07');
 reschedule(plan,state,'2026-10-01','architecture');completeCourse(plan,state,'architecture-design',now);validateState(plan,state);
 const later=createState(plan,now,'2026-10-07');reschedule(plan,later,'2026-10-20','architecture');
 assert.throws(()=>completeCourse(plan,later,'architecture-design',now),/ещё/);
 completeCourse(plan,later,'architecture-design',new Date('2026-10-20T12:00Z'));
 assert.equal(later.CourseStarted['architecture-design'],'2026-10-19T19:00:00.000Z');
});
test('finished tracks retain their valid history when other dates change',()=>{
 const state=fresh();for(const c of plan.Courses.filter(c=>c.TrackId==='architecture'))completeCourse(plan,state,c.Id,new Date('2026-11-02T12:00Z'));
 reschedule(plan,state,'2026-11-20');validateState(plan,state);assert.equal(state.TrackPlanStart.architecture,'2026-10-07');
});
test('final eligible day does not append a second reserve',()=>{
 const state=fresh();for(const c of plan.Courses.filter(c=>c.TrackId==='architecture').slice(0,-1))completeCourse(plan,state,c.Id,new Date('2026-10-08T14:00Z'));
 for(const d of ['2026-11-01','2026-11-02'])assert.equal(dayISO(buildSchedule(plan,state,new Date(d+'T12:00Z')).tracks.find(t=>t.Id==='architecture').end),'2026-11-02');
 assert.equal(dayISO(buildSchedule(plan,state,new Date('2026-11-03T12:00Z')).tracks.find(t=>t.Id==='architecture').end),'2026-11-05');
});
test('general entrepreneurship hides its pending courses from actions and reminders',()=>{
 let state=applyAction(plan,fresh(),{type:'program',program:'general'}),current=effectivePlan(plan,state);
 assert.equal(current.Courses.length,26);assert.equal(current.Tracks.length,3);
 assert.throws(()=>applyAction(plan,state,{type:'complete',id:'entrepreneurship-scaleup'}),/Неизвестный/);
 for(let i=0;i<32;i++){state.ReminderCursor=i;assert.notEqual(reminderTarget(current,state,new Date('2026-10-08T14:00Z')).course.TrackId,'entrepreneurship');}
 state=applyAction(plan,state,{type:'program',program:'technological'});assert.equal(effectivePlan(plan,state).Courses.length,32);
});
